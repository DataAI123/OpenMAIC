/**
 * Verify Video Provider API.
 *
 * Legacy mode retains the provider-wide probe behavior. OIDC mode supports
 * only the BYOK OpenRouter key metadata GET; it never starts a video job.
 */
import type { NextRequest } from 'next/server';

import { resolveVideoKeyProbe, testVideoConnectivity } from '@/lib/media/video-providers';
import type { ProviderKeyProbeResult } from '@/lib/media/provider-key-probe';
import type { VideoProviderId } from '@/lib/media/types';
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
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
  resolveServerVideoProviderId,
} from '@/lib/server/provider-config';
import {
  createProviderVerificationTransport,
  keyProbeTransportOptions,
} from '@/lib/server/provider-verification-transport';
import {
  consumeVideoProviderVerificationRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';

const log = createLogger('VerifyVideoProvider');
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

    const providerId = request.headers.get('x-video-provider')?.trim() ?? '';
    const probe = resolveVideoKeyProbe(providerId);
    if (!probe) {
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'Video verification is unavailable for this provider',
        responseHeaders,
      );
    }
    if (isServerProviderDisabled('video', providerId)) {
      return ownerApiError(
        'PROVIDER_DISABLED',
        403,
        'This video provider is disabled',
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
      await consumeVideoProviderVerificationRateLimit(ownerId);
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return ownerApiError(
          'RATE_LIMITED',
          429,
          'Too many video verification requests',
          responseHeaders,
        );
      }
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'Video verification is unavailable',
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
      return ownerApiError('INTERNAL_ERROR', 502, 'Video verification failed', responseHeaders);
    } finally {
      await transport?.close().catch(() => undefined);
    }
  });
}

async function legacyPost(request: NextRequest): Promise<Response> {
  try {
    const providerId = (request.headers.get('x-video-provider')?.trim() ||
      resolveServerVideoProviderId()) as VideoProviderId;
    if (!providerId) {
      return apiError('MISSING_PROVIDER', 400, 'No video provider configured');
    }
    if (isServerProviderDisabled('video', providerId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This video provider is disabled by the server');
    }
    const clientModel = request.headers.get('x-video-model')?.trim() || undefined;
    const managed = isServerConfiguredProvider('video', providerId);
    const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);
    }

    const apiKey = resolveVideoApiKey(providerId, clientApiKey);
    const baseUrl = resolveVideoBaseUrl(providerId, clientBaseUrl);
    if (!apiKey) return apiError('MISSING_API_KEY', 400, 'No API key configured');

    const model = resolveVideoModel(providerId, clientModel);
    if (!model) {
      return apiError(
        'MISSING_MODEL',
        400,
        `No model configured for video provider: ${providerId}`,
      );
    }

    const result = await testVideoConnectivity({ providerId, apiKey, baseUrl, model });
    if (!result.success) return apiError('UPSTREAM_ERROR', 500, result.message);
    return apiSuccess({ message: result.message });
  } catch (error) {
    log.error(`Video provider verification failed: ${error}`, error);
    return apiError('INTERNAL_ERROR', 500, `Connectivity test error: ${error}`);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  let oidcMode: boolean;
  try {
    oidcMode = resolveAuthConfig().mode === 'oidc';
  } catch {
    return stampRequestId(
      apiError('INTERNAL_ERROR', 503, 'Video verification is unavailable.'),
      request.headers,
    );
  }
  if (oidcMode) return oidcPost(request);
  return stampRequestId(await legacyPost(request), request.headers);
}
