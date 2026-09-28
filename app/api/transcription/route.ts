import { NextRequest } from 'next/server';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveASRApiKey,
  resolveASRBaseUrl,
  resolveASRModel,
  resolveServerASRProviderId,
} from '@/lib/server/provider-config';
import type { ASRProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { findUnsafeNetworkTargetError, validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
import { ownerApiError } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  consumeActionRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';
import { resolveAuthConfig } from '@/lib/server/auth/config';
const log = createLogger('Transcription');

export const maxDuration = 60;

async function handlePost(req: NextRequest, oidcMode: boolean) {
  let resolvedProviderId: string | undefined;
  let resolvedModelId: string | undefined;
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    const providerId = formData.get('providerId') as ASRProviderId | null;
    // Trim the client model id and normalize empty → undefined, matching the
    // image/video generation routes (a pinned server model must never be
    // shadowed by a whitespace-padded client id).
    const modelId = (formData.get('modelId') as string | null)?.trim() || undefined;
    const language = formData.get('language') as string | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!audioFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Audio file is required');
    }

    // Prefer an enabled operator-configured backend when the client omitted its
    // selection. Never guess a vendor: fail loudly when no backend is enabled.
    const effectiveProviderId =
      providerId || (resolveServerASRProviderId() as ASRProviderId | undefined);
    if (!effectiveProviderId) {
      return apiError('MISSING_PROVIDER', 400, 'No enabled ASR provider is configured');
    }
    resolvedProviderId = effectiveProviderId;
    resolvedModelId = modelId;

    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection — mirror the TTS contract (#665).
    if (isServerProviderDisabled('asr', effectiveProviderId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This ASR provider is disabled by the server');
    }

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('asr', effectiveProviderId);
    const clientBaseUrl = managed ? undefined : baseUrl || undefined;
    // A client-supplied BYOK base URL is always judged under the strict public
    // policy, even when the operator enabled local networks for their own
    // server-configured ASR backend.
    const publicOnly = Boolean(clientBaseUrl);
    if (clientBaseUrl) {
      const ssrfError = await validatePublicUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: effectiveProviderId,
      // A managed provider may pin its model list server-side
      // (ASR_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
      // first pinned entry is the managed default; unmanaged providers use the
      // client model directly.
      modelId: resolveASRModel(effectiveProviderId, modelId),
      language: language || 'auto',
      apiKey: resolveASRApiKey(effectiveProviderId, managed ? undefined : apiKey || undefined),
      baseUrl: resolveASRBaseUrl(effectiveProviderId, clientBaseUrl),
      publicOnly,
    };
    // Reflect the resolved (possibly server-pinned) model in failure logs.
    resolvedModelId = config.modelId;

    // Transcribe using the provider system
    const result = await transcribeAudio(config, audioFile);

    return apiSuccess({ text: result.text });
  } catch (error) {
    if (oidcMode) {
      log.error('Transcription failed for an OIDC request');
    } else {
      log.error(
        `Transcription failed [provider=${resolvedProviderId ?? 'unknown'}, model=${resolvedModelId ?? 'default'}]:`,
        error,
      );
    }
    const blocked = findUnsafeNetworkTargetError(error);
    if (blocked) {
      return apiError(
        'INVALID_URL',
        403,
        oidcMode ? 'The ASR provider URL is not allowed.' : blocked.message,
      );
    }
    return apiError(
      'TRANSCRIPTION_FAILED',
      500,
      oidcMode ? 'Transcription failed. Please try again later.' : 'Transcription failed',
      oidcMode ? undefined : error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

export async function POST(req: NextRequest) {
  let oidcMode: boolean;
  try {
    oidcMode = resolveAuthConfig().mode === 'oidc';
  } catch {
    return apiError('INTERNAL_ERROR', 503, 'Transcription is unavailable.');
  }
  if (!oidcMode) return handlePost(req, false);

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    responseHeaders.set('Cache-Control', 'private, no-store');
    try {
      await consumeActionRateLimit(ownerId, 'transcription');
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return ownerApiError(
          'RATE_LIMITED',
          429,
          'Too many transcription requests',
          responseHeaders,
        );
      }
      return ownerApiError('INTERNAL_ERROR', 503, 'Rate limiting is unavailable', responseHeaders);
    }
    const response = await handlePost(req, true);
    const headers = new Headers(response.headers);
    responseHeaders.forEach((value, name) => headers.set(name, value));
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}
