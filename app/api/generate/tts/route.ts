/**
 * Single TTS Generation API
 *
 * Generates TTS audio for a single text string and returns base64-encoded audio.
 * Called by the client in parallel for each speech action after a scene is generated.
 *
 * POST /api/generate/tts
 */

import { NextRequest } from 'next/server';
import {
  generateTTS,
  QwenTTSError,
  TTSInvalidResponseError,
  TTSRateLimitError,
} from '@/lib/audio/tts-providers';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
  TTSModelNotAllowedError,
} from '@/lib/server/provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { beginMediaQuota, settleMediaQuota } from '@/lib/server/media-quota-route';
import { findUnsafeNetworkTargetError, validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import { QwenVoiceCloneError, qwenVoiceCloneErrorMessage } from '@/lib/audio/qwen-voice-clone';
import { isQwenCloneVoice } from '@/lib/audio/constants';

const log = createLogger('TTS API');

export const maxDuration = 30;

// Coarse abuse bound on a single request's speech text, deliberately set far
// above every real per-provider limit (the largest is ~4k chars) and above the
// client's own sentence-level chunking — it only stops a pathologically large
// body from reserving/quota-charging text it could never synthesize.
const TTS_MAX_TEXT_CHARS = 100_000;

export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    let ttsProviderId: string | undefined;
    let ttsVoice: string | undefined;
    let audioId: string | undefined;
    try {
      const body = await req.json();
      const { text, ttsModelId, ttsSpeed, ttsApiKey, ttsBaseUrl, ttsProviderOptions } = body as {
        text: string;
        audioId: string;
        ttsProviderId: TTSProviderId;
        ttsModelId?: string;
        ttsVoice: string;
        ttsSpeed?: number;
        ttsApiKey?: string;
        ttsBaseUrl?: string;
        ttsProviderOptions?: Record<string, unknown>;
      };
      ttsProviderId = body.ttsProviderId;
      ttsVoice = typeof body.ttsVoice === 'string' ? body.ttsVoice.trim() : undefined;
      audioId = body.audioId;

      // Validate required fields
      if (!text || !audioId || !ttsProviderId || !ttsVoice) {
        return withOwnerResponseHeaders(
          apiError(
            'MISSING_REQUIRED_FIELD',
            400,
            'Missing required fields: text, audioId, ttsProviderId, ttsVoice',
          ),
          responseHeaders,
        );
      }

      // Bound untrusted input BEFORE the quota reservation. Real per-provider
      // limits are enforced in the TTS library; this coarse guard stops an
      // oversized/malformed text from reserving (and, on a provider rejection
      // that bills the conservative full reservation, paying for) audio the
      // request could never produce.
      if (typeof text !== 'string' || text.length > TTS_MAX_TEXT_CHARS) {
        return withOwnerResponseHeaders(
          apiError('INVALID_REQUEST', 400, 'Speech text is missing or exceeds the length limit'),
          responseHeaders,
        );
      }

      // Reject browser-native TTS — must be handled client-side
      if (ttsProviderId === 'browser-native-tts') {
        return withOwnerResponseHeaders(
          apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side'),
          responseHeaders,
        );
      }

      // Enforce server precedence: a force-disabled provider is off for everyone,
      // regardless of any client key/selection (#665).
      if (isServerTTSProviderDisabled(ttsProviderId)) {
        return withOwnerResponseHeaders(
          apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server'),
          responseHeaders,
        );
      }

      const voxcpmVoicePrompt =
        typeof ttsProviderOptions?.voicePrompt === 'string' ? ttsProviderOptions.voicePrompt : '';
      const voxcpmRegisteredVoiceId =
        typeof ttsProviderOptions?.registeredVoiceId === 'string'
          ? ttsProviderOptions.registeredVoiceId
          : '';
      if (
        ttsProviderId === VOXCPM_TTS_PROVIDER_ID &&
        ttsVoice === VOXCPM_AUTO_VOICE_ID &&
        !voxcpmVoicePrompt.trim() &&
        !voxcpmRegisteredVoiceId.trim()
      ) {
        return withOwnerResponseHeaders(
          apiError(
            'VOXCPM_AUTO_VOICE_REQUIRES_CONTEXT',
            400,
            'VoxCPM Auto Voice requires agent context',
          ),
          responseHeaders,
        );
      }

      // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
      const managed = isServerConfiguredProvider('tts', ttsProviderId);
      const clientBaseUrl = managed ? undefined : ttsBaseUrl || undefined;
      // A client-supplied BYOK base URL always runs under the strict public
      // policy; only a server-managed (or built-in default) target may inherit the
      // operator's ALLOW_LOCAL_NETWORKS opt-in. Never derived from request input.
      const publicOnly = Boolean(clientBaseUrl);
      if (clientBaseUrl) {
        const ssrfError = await validatePublicUrlForSSRF(clientBaseUrl);
        if (ssrfError) {
          return withOwnerResponseHeaders(apiError('INVALID_URL', 403, ssrfError), responseHeaders);
        }
      }

      const apiKey = resolveTTSApiKey(ttsProviderId, managed ? undefined : ttsApiKey || undefined);
      const baseUrl = resolveTTSBaseUrl(ttsProviderId, clientBaseUrl);

      // Pre-flight the same key requirement the library enforces: a keyed provider
      // with no key (server config AND client-supplied key both absent) is a
      // client contract violation, not a server failure. Return the image route's
      // MISSING_API_KEY envelope instead of falling through to a 500
      // GENERATION_FAILED. Unknown/custom providers keep their existing behavior.
      const ttsProvider = TTS_PROVIDERS[ttsProviderId as keyof typeof TTS_PROVIDERS];
      if (ttsProvider?.requiresApiKey && !apiKey) {
        return withOwnerResponseHeaders(
          apiError(
            'MISSING_API_KEY',
            400,
            `No API key configured for TTS provider: ${ttsProviderId}`,
          ),
          responseHeaders,
        );
      }

      // Build TTS config (managed providers may pin the model server-side)
      const qwenCloneVoice = ttsProviderId === 'qwen-tts' && isQwenCloneVoice(ttsVoice);
      const requestedSpeed = ttsSpeed ?? 1.0;
      const resolvedModelId = resolveTTSModel(ttsProviderId, ttsModelId, ttsVoice);
      const config = {
        providerId: ttsProviderId as TTSProviderId,
        modelId: resolvedModelId,
        voice: ttsVoice,
        speed: qwenCloneVoice ? 1 : requestedSpeed,
        apiKey,
        baseUrl,
        publicOnly,
        providerOptions: {
          ...(ttsProviderOptions || {}),
          ...(qwenCloneVoice ? { qwenVoiceClone: true } : {}),
        },
      };

      log.info(
        `Generating TTS: provider=${ttsProviderId}, model=${config.modelId || 'default'}, voice=${ttsVoice}, ` +
          `registeredVoiceId=${voxcpmRegisteredVoiceId || 'none'}, audioId=${audioId}, textLen=${text.length}`,
      );

      // TTS is metered by input character count, reserved before the call.
      const gate = await beginMediaQuota(ownerId, 'tts', text.length);
      if (gate.kind === 'exceeded') {
        return withOwnerResponseHeaders(
          apiError('RATE_LIMITED', 429, 'Personal monthly TTS quota exceeded'),
          responseHeaders,
        );
      }
      if (gate.kind === 'unavailable') {
        return withOwnerResponseHeaders(
          apiError('INTERNAL_ERROR', 503, 'TTS quota service is unavailable'),
          responseHeaders,
        );
      }

      // Generate audio
      let audio: Uint8Array;
      let format: string;
      try {
        ({ audio, format } = await generateTTS(config, text));
      } catch (generationError) {
        await settleMediaQuota(gate, null);
        throw generationError;
      }
      await settleMediaQuota(gate, text.length);

      void recordGenerationUsage({
        kind: 'tts',
        unit: 'character',
        providerId: ttsProviderId,
        modelId: config.modelId,
        quantity: text.length,
      });

      // Convert to base64
      const base64 = Buffer.from(audio).toString('base64');

      return withOwnerResponseHeaders(apiSuccess({ audioId, base64, format }), responseHeaders);
    } catch (error) {
      log.error(
        `TTS generation failed [provider=${ttsProviderId ?? 'unknown'}, voice=${ttsVoice ?? 'unknown'}, audioId=${audioId ?? 'unknown'}]:`,
        error,
      );
      const blocked = findUnsafeNetworkTargetError(error);
      if (blocked) {
        return withOwnerResponseHeaders(
          apiError('INVALID_URL', 403, blocked.message),
          responseHeaders,
        );
      }
      if (error instanceof TTSRateLimitError) {
        return withOwnerResponseHeaders(
          apiError('RATE_LIMITED', 429, error.message),
          responseHeaders,
        );
      }
      if (error instanceof TTSInvalidResponseError) {
        return withOwnerResponseHeaders(
          apiError(error.code, error.httpStatus, error.message),
          responseHeaders,
        );
      }
      if (error instanceof QwenVoiceCloneError) {
        return withOwnerResponseHeaders(
          apiError(error.code, error.httpStatus || 502, qwenVoiceCloneErrorMessage(error)),
          responseHeaders,
        );
      }
      if (error instanceof QwenTTSError) {
        return withOwnerResponseHeaders(
          apiError(error.code, error.httpStatus, error.message),
          responseHeaders,
        );
      }
      if (error instanceof TTSModelNotAllowedError) {
        return withOwnerResponseHeaders(
          apiError(error.code, error.httpStatus, error.message),
          responseHeaders,
        );
      }
      return withOwnerResponseHeaders(
        apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error)),
        responseHeaders,
      );
    }
  });
}
