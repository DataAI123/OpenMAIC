/**
 * Image Generation API
 *
 * Generates an image from a text prompt using the specified provider.
 * Called by the client during media generation after slides are produced.
 *
 * POST /api/generate/image
 *
 * Headers:
 *   x-image-provider: ImageProviderId (optional, server-configured default)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, negativePrompt?, width?, height?, aspectRatio?, style? }
 * Response: { success: boolean, result?: ImageGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { IMAGE_PROVIDERS } from '@/lib/media/constants';
import { generateImage } from '@/lib/media/image-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveServerImageProviderId,
} from '@/lib/server/provider-config';
import type { ImageProviderId, ImageGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { beginMediaQuota, settleMediaQuota } from '@/lib/server/media-quota-route';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { resolveImageSize } from '@/lib/server/image-sizing';

const log = createLogger('ImageGeneration API');

// The ComfyUI adapter polls up to GENERATION_TIMEOUT_MS (5 min) and real
// workflows can take 3–5 min. 60s would let platforms that enforce maxDuration
// (e.g. Vercel) kill the request ~4 min before the adapter finishes. 300s is
// the practical ceiling on most managed platforms and matches the poll budget.
// (Self-hosted Node servers ignore this value entirely.)
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  return withRequestOwnerId(request, async (ownerId, responseHeaders) => {
    // Server-managed (admin-owned) provider flag. Declared outside the try so the
    // catch can gate how much upstream error detail reaches the client.
    let managed = false;
    try {
      const body = (await request.json()) as ImageGenerationOptions;

      if (!body.prompt) {
        return withOwnerResponseHeaders(
          apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt'),
          responseHeaders,
        );
      }

      // The client may express no provider preference (empty header) — fall back
      // to the first server-configured image provider, else fail loud.
      const providerId = (request.headers.get('x-image-provider')?.trim() ||
        resolveServerImageProviderId()) as ImageProviderId;
      if (!providerId) {
        return withOwnerResponseHeaders(
          apiError('MISSING_PROVIDER', 400, 'No image provider configured'),
          responseHeaders,
        );
      }
      // Enforce server precedence: a force-disabled provider is off for everyone,
      // regardless of any client key/selection — mirror the TTS contract (#665).
      if (isServerProviderDisabled('image', providerId)) {
        return withOwnerResponseHeaders(
          apiError('PROVIDER_DISABLED', 403, 'This image provider is disabled by the server'),
          responseHeaders,
        );
      }
      // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
      managed = isServerConfiguredProvider('image', providerId);
      const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
      const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;
      const clientModel = request.headers.get('x-image-model')?.trim() || undefined;

      if (clientBaseUrl) {
        const ssrfError = await validateUrlForSSRF(clientBaseUrl);
        if (ssrfError) {
          return withOwnerResponseHeaders(apiError('INVALID_URL', 403, ssrfError), responseHeaders);
        }
      }

      const apiKey = resolveImageApiKey(providerId, clientApiKey);
      const provider = IMAGE_PROVIDERS[providerId];
      if (provider?.requiresApiKey && !apiKey) {
        return withOwnerResponseHeaders(
          apiError(
            'MISSING_API_KEY',
            401,
            `No API key configured for image provider: ${providerId}`,
          ),
          responseHeaders,
        );
      }

      const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

      // A managed provider may pin its model list server-side
      // (IMAGE_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
      // first pinned entry is the managed default; unmanaged providers use the
      // client header directly.
      const model = resolveImageModel(providerId, clientModel);
      // Workflow-based providers (e.g. comfyui-image) have no model catalog and
      // need no model; everyone else must resolve one.
      if (!model && provider?.models && provider.models.length > 0) {
        return withOwnerResponseHeaders(
          apiError('MISSING_MODEL', 400, `No model configured for image provider: ${providerId}`),
          responseHeaders,
        );
      }

      const sizedOptions = resolveImageSize(body, { providerId, modelId: model });

      log.info(
        `Generating image: provider=${providerId}, model=${model || 'default'}, ` +
          `prompt="${sizedOptions.prompt.slice(0, 80)}...", size=${sizedOptions.width ?? 'auto'}x${sizedOptions.height ?? 'auto'}`,
      );

      // Personal image quota is checked only after every validation and provider
      // resolution step so a rejected request never reserves (or is charged for)
      // quota. Legacy anonymous owners are skipped inside beginMediaQuota.
      const gate = await beginMediaQuota(ownerId, 'image', 1);
      if (gate.kind === 'exceeded') {
        return withOwnerResponseHeaders(
          apiError('RATE_LIMITED', 429, 'Personal monthly image quota exceeded'),
          responseHeaders,
        );
      }
      if (gate.kind === 'unavailable') {
        return withOwnerResponseHeaders(
          apiError('INTERNAL_ERROR', 503, 'Image quota service is unavailable'),
          responseHeaders,
        );
      }

      let result;
      try {
        // `clientBaseUrl` is the only base URL the route treats as untrusted
        // input (managed providers ignore any client-sent URL); pass it through
        // so the adapter pins connect-time DNS and revalidates redirects for
        // exactly the endpoint validated above.
        result = await generateImage(
          { providerId, apiKey, baseUrl, model, pinSsrfConnections: Boolean(clientBaseUrl) },
          sizedOptions,
        );
      } catch (generationError) {
        // The provider call was issued, so charge conservatively; the image may
        // have been billed upstream regardless of the error we received.
        await settleMediaQuota(gate, null);
        throw generationError;
      }
      await settleMediaQuota(gate, 1);

      void recordGenerationUsage({
        kind: 'image',
        unit: 'image',
        providerId,
        modelId: model,
        quantity: 1,
      });

      return withOwnerResponseHeaders(apiSuccess({ result }), responseHeaders);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Detect content safety filter rejections (e.g. Seedream OutputImageSensitiveContentDetected)
      if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
        log.warn(`Image blocked by content safety filter: ${message}`);
        return withOwnerResponseHeaders(
          apiError('CONTENT_SENSITIVE', 400, message),
          responseHeaders,
        );
      }
      log.error(`Image generation failed: ${message}`, error);
      // Managed (operator-configured) providers: never echo the raw upstream
      // error body to the client — it can carry operator account/quota/internal
      // detail meant for a different audience. Full text stays in the server log
      // above. BYOK callers own the provider account, so they keep the provider
      // message to debug their own configuration.
      const clientMessage = managed ? 'Image generation failed. Please try again.' : message;
      return withOwnerResponseHeaders(
        apiError('INTERNAL_ERROR', 500, clientMessage),
        responseHeaders,
      );
    }
  });
}
