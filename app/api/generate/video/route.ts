/**
 * Video Generation API
 *
 * Generates a video from a text prompt using the specified provider.
 * Uses async task pattern (submit → poll) so maxDuration is set to 5 minutes.
 *
 * POST /api/generate/video
 *
 * Headers:
 *   x-video-provider: VideoProviderId (optional, server-configured default)
 *   x-video-model: string (optional model override)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, duration?, aspectRatio?, resolution? }
 * Response: { success: boolean, result?: VideoGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
  resolveServerVideoProviderId,
} from '@/lib/server/provider-config';
import type { VideoProviderId, VideoGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { beginMediaQuota, settleMediaQuota } from '@/lib/server/media-quota-route';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('VideoGeneration API');

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  return withRequestOwnerId(request, async (ownerId, responseHeaders) => {
    // Server-managed (admin-owned) provider flag. Declared outside the try so the
    // catch can gate how much upstream error detail reaches the client.
    let managed = false;
    try {
      const body = (await request.json()) as VideoGenerationOptions;

      if (!body.prompt) {
        return withOwnerResponseHeaders(
          apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt'),
          responseHeaders,
        );
      }

      // The client may express no provider preference (empty header) — fall back
      // to the first server-configured video provider, else fail loud.
      const providerId = (request.headers.get('x-video-provider')?.trim() ||
        resolveServerVideoProviderId()) as VideoProviderId;
      if (!providerId) {
        return withOwnerResponseHeaders(
          apiError('MISSING_PROVIDER', 400, 'No video provider configured'),
          responseHeaders,
        );
      }
      // Enforce server precedence: a force-disabled provider is off for everyone,
      // regardless of any client key/selection — mirror the TTS contract (#665).
      if (isServerProviderDisabled('video', providerId)) {
        return withOwnerResponseHeaders(
          apiError('PROVIDER_DISABLED', 403, 'This video provider is disabled by the server'),
          responseHeaders,
        );
      }
      // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
      managed = isServerConfiguredProvider('video', providerId);
      const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
      const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;
      const clientModel = request.headers.get('x-video-model')?.trim() || undefined;

      if (clientBaseUrl) {
        const ssrfError = await validateUrlForSSRF(clientBaseUrl);
        if (ssrfError) {
          return withOwnerResponseHeaders(apiError('INVALID_URL', 403, ssrfError), responseHeaders);
        }
      }

      const apiKey = resolveVideoApiKey(providerId, clientApiKey);
      if (!apiKey) {
        return withOwnerResponseHeaders(
          apiError(
            'MISSING_API_KEY',
            401,
            `No API key configured for video provider: ${providerId}`,
          ),
          responseHeaders,
        );
      }

      const baseUrl = resolveVideoBaseUrl(providerId, clientBaseUrl);

      // A managed provider may pin its model list server-side
      // (VIDEO_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
      // first pinned entry is the managed default; unmanaged providers use the
      // client header directly.
      const model = resolveVideoModel(providerId, clientModel);
      if (!model) {
        return withOwnerResponseHeaders(
          apiError('MISSING_MODEL', 400, `No model configured for video provider: ${providerId}`),
          responseHeaders,
        );
      }

      // Normalize options against provider capabilities
      const options = normalizeVideoOptions(providerId, body);

      log.info(
        `Generating video: provider=${providerId}, model=${model || 'default'}, ` +
          `prompt="${body.prompt.slice(0, 80)}...", duration=${options.duration ?? 'auto'}, ` +
          `aspect=${options.aspectRatio ?? 'auto'}, resolution=${options.resolution ?? 'auto'}`,
      );

      // Reserve the normalized (provider-bounded) duration when known; otherwise
      // reserve a 1-second floor and settle to the real reported duration, which
      // is authoritative even when it exceeds the reservation.
      const plannedSeconds =
        Number.isSafeInteger(options.duration) && (options.duration as number) > 0
          ? (options.duration as number)
          : 1;
      const gate = await beginMediaQuota(ownerId, 'video', plannedSeconds);
      if (gate.kind === 'exceeded') {
        return withOwnerResponseHeaders(
          apiError('RATE_LIMITED', 429, 'Personal monthly video quota exceeded'),
          responseHeaders,
        );
      }
      if (gate.kind === 'unavailable') {
        return withOwnerResponseHeaders(
          apiError('INTERNAL_ERROR', 503, 'Video quota service is unavailable'),
          responseHeaders,
        );
      }

      let result;
      try {
        result = await generateVideo(
          { providerId, apiKey, baseUrl, model, pinSsrfConnections: Boolean(clientBaseUrl) },
          options,
        );
      } catch (generationError) {
        await settleMediaQuota(gate, null);
        throw generationError;
      }
      const actualSeconds =
        Number.isSafeInteger(Math.ceil(result.duration)) && Math.ceil(result.duration) > 0
          ? Math.ceil(result.duration)
          : plannedSeconds;
      await settleMediaQuota(gate, actualSeconds);

      log.info(
        `Video generated: url=${result.url ? 'yes' : 'no'}, ${result.width}x${result.height}, ${result.duration}s`,
      );

      void recordGenerationUsage({
        kind: 'video',
        unit: 'second',
        providerId,
        modelId: model,
        quantity: result.duration,
      });

      return withOwnerResponseHeaders(apiSuccess({ result }), responseHeaders);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Detect content safety filter rejections (e.g. Seedance SensitiveContent errors)
      if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
        log.warn(`Video blocked by content safety filter: ${message}`);
        return withOwnerResponseHeaders(
          apiError('CONTENT_SENSITIVE', 400, message),
          responseHeaders,
        );
      }
      log.error(`Video generation failed: ${message}`, error);
      // Managed (operator-configured) providers: never echo the raw upstream
      // error body to the client — it can carry operator account/quota/internal
      // detail meant for a different audience. Full text stays in the server log
      // above. BYOK callers own the provider account, so they keep the provider
      // message to debug their own configuration.
      const clientMessage = managed ? 'Video generation failed. Please try again.' : message;
      return withOwnerResponseHeaders(
        apiError('INTERNAL_ERROR', 500, clientMessage),
        responseHeaders,
      );
    }
  });
}
