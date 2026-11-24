/**
 * Verify Image Provider API.
 *
 * Legacy mode keeps the existing provider-wide probe behavior. OIDC mode only
 * supports the BYOK OpenRouter key metadata endpoint, which is a read-only GET
 * and never requests image generation.
 */
import type { NextRequest } from 'next/server';

import { IMAGE_PROVIDERS } from '@/lib/media/constants';
import { resolveImageKeyProbe, testImageConnectivity } from '@/lib/media/image-providers';
import type { ProviderKeyProbeResult } from '@/lib/media/provider-key-probe';
import type { ImageProviderId } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { stampRequestId } from '@/lib/server/request-id';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { resolveAuthConfig } from '@/lib/server/auth/config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveServerImageProviderId,
} from '@/lib/server/provider-config';
import {
  createProviderVerificationTransport,
  keyProbeTransportOptions,
} from '@/lib/server/provider-verification-transport';
import {
  consumeImageProviderVerificationRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';

const log = createLogger('VerifyImageProvider');
const MAX_API_KEY_LENGTH = 8192;
const VERIFY_TIMEOUT_MS = 20_000;

export const maxDuration = 30;

function probeOutcomeResponse(result: ProviderKeyProbeResult, headers: Headers): Response {
  switch (result.outcome) {
    case 'ok':
      return ownerJson({ success: true, message: result.message }, 200, headers);
    case 'redirect':
      return ownerApiError(
        'REDIRECT_NOT_ALLOWED',
        403,
        'Provider redirects are not allowed',
        headers,
      );
    case 'invalid-key':
      return ownerApiError('INVALID_REQUEST', 401, result.message, headers);
    case 'upstream-error':
      return ownerApiError('INTERNAL_ERROR', 502, result.message, headers);
  }
}

async function oidcPost(request: NextRequest): Promise<Response> {
  return withRequestOwnerId(request, async (ownerId, responseHeaders) => {
    responseHeaders.set('Cache-Control', 'private, no-store');
    if (!ownerId.startsWith('user:') || ownerId.length === 'user:'.length) {
      return ownerApiError('UNAUTHENTICATED', 401, 'Login is required', responseHeaders);
    }

    const providerId = request.headers.get('x-image-provider')?.trim() ?? '';
    const probe = resolveImageKeyProbe(providerId);
    if (!probe) {
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'Image verification is unavailable for this provider',
        responseHeaders,
      );
    }
    if (isServerProviderDisabled('image', providerId)) {
      return ownerApiError(
        'PROVIDER_DISABLED',
        403,
        'This image provider is disabled',
        responseHeaders,
      );
    }

    const apiKey = request.headers.get('x-api-key')?.trim() ?? '';
    if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH) {
      return ownerApiError('INVALID_REQUEST', 400, probe.missingKeyMessage, responseHeaders);
    }
    if (!probe.isBaseUrlAllowed(request.headers.get('x-base-url'))) {
      return ownerApiError('INVALID_REQUEST', 400, probe.rejectedBaseUrlMessage, responseHeaders);
    }
    if (request.body) {
      await request.body.cancel().catch(() => undefined);
      return ownerApiError(
        'INVALID_REQUEST',
        400,
        'Request body is not supported',
        responseHeaders,
      );
    }

    try {
      await consumeImageProviderVerificationRateLimit(ownerId);
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return ownerApiError(
          'RATE_LIMITED',
          429,
          'Too many image verification requests',
          responseHeaders,
        );
      }
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'Image verification is unavailable',
        responseHeaders,
      );
    }

    let transport: ReturnType<typeof createProviderVerificationTransport> | undefined;
    try {
      transport = createProviderVerificationTransport(keyProbeTransportOptions());
      const result = await probe.probe({
        apiKey,
        transport,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      return probeOutcomeResponse(result, responseHeaders);
    } catch {
      return ownerApiError('INTERNAL_ERROR', 502, 'Image verification failed', responseHeaders);
    } finally {
      await transport?.close().catch(() => undefined);
    }
  });
}

async function legacyPost(request: NextRequest): Promise<Response> {
  try {
    const providerId = (request.headers.get('x-image-provider')?.trim() ||
      resolveServerImageProviderId()) as ImageProviderId;
    if (!providerId) {
      return apiError('MISSING_PROVIDER', 400, 'No image provider configured');
    }
    // A force-disabled provider is off for everyone, regardless of client key.
    if (isServerProviderDisabled('image', providerId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This image provider is disabled by the server');
    }
    const clientModel = request.headers.get('x-image-model')?.trim() || undefined;
    const managed = isServerConfiguredProvider('image', providerId);
    const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);
    }
    const apiKey = resolveImageApiKey(providerId, clientApiKey);
    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);
    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const model = resolveImageModel(providerId, clientModel);
    if (!model && provider?.models && provider.models.length > 0) {
      return apiError(
        'MISSING_MODEL',
        400,
        `No model configured for image provider: ${providerId}`,
      );
    }

    const result = await testImageConnectivity({ providerId, apiKey, baseUrl, model });
    if (!result.success) return apiError('UPSTREAM_ERROR', 500, result.message);
    return apiSuccess({ message: result.message });
  } catch (error) {
    log.error(`Image provider verification failed: ${error}`, error);
    return apiError('INTERNAL_ERROR', 500, `Connectivity test error: ${error}`);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  let oidcMode: boolean;
  try {
    oidcMode = resolveAuthConfig().mode === 'oidc';
  } catch {
    return stampRequestId(
      apiError('INTERNAL_ERROR', 503, 'Image verification is unavailable.'),
      request.headers,
    );
  }
  if (oidcMode) return oidcPost(request);
  return stampRequestId(await legacyPost(request), request.headers);
}
