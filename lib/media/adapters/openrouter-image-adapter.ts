/**
 * OpenRouter Image Generation Adapter
 *
 * OpenRouter's dedicated image endpoint — one key for every hosted image model
 * (Seedream, GPT Image, Gemini/Nano Banana, Qwen Image, Recraft, Krea, ...).
 *
 * Endpoints:
 * - Generate: POST /images   { model, prompt, aspect_ratio?, n?, output_format? }
 *             → { created, data: [{ b64_json, media_type? }] }
 * - Catalog:  GET  /images/models  → { data: [{ id, name? }] }
 *
 * Note this is NOT the OpenAI-compatible `/images/generations` shape (that path
 * 404s on OpenRouter), and it is not chat-completions either. It is its own
 * endpoint that answers inline base64.
 *
 * Authentication: Authorization: Bearer <key>
 *
 * API docs: https://openrouter.ai/docs/api-reference/overview
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { requireModel } from '../require-model';
import { imageProviderFetch } from '../provider-fetch';
import type {
  ProviderKeyProbe,
  ProviderKeyProbeInput,
  ProviderKeyProbeResult,
} from '../provider-key-probe';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Dimension defaults per aspect ratio, mirroring the other image adapters. */
function getDimensions(aspectRatio?: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: 720, height: 1280 };
    case '1:1':
      return { width: 1024, height: 1024 };
    case '4:3':
      return { width: 1024, height: 768 };
    default:
      return { width: 1280, height: 720 }; // 16:9
  }
}

/**
 * Normalise a user-entered base URL to the API root.
 *
 * The settings field is labelled "Base URL" but reads like a request URL, so
 * pasting the full endpoint (`.../api/v1/images`) is the natural mistake — and
 * it silently builds `.../api/v1/images/images`, which 404s. Trim a trailing
 * slash and a trailing `/images` or `/videos` so both forms work.
 */
export function openRouterBaseUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '').replace(/\/(images|videos)$/, '');
}

export function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

interface OpenRouterImageResponse {
  created?: number;
  data?: Array<{ b64_json?: string; media_type?: string }>;
  error?: { code?: string | number; message?: string };
}

/**
 * Lightweight connectivity test — reads the key's own metadata. Costs nothing
 * and never triggers a generation.
 *
 * Deliberately NOT the `/images/models` catalog: that answers 200
 * unauthenticated, so probing it would report success for an invalid key.
 * `GET /key` is the cheapest endpoint that actually rejects a bad key.
 */
export async function testOpenRouterImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = openRouterBaseUrl(config.baseUrl);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/key`, {
      method: 'GET',
      redirect: 'manual',
      headers: openRouterHeaders(config.apiKey),
    });
  } catch {
    return {
      success: false,
      message: `Network error: unable to reach ${baseUrl}. Check your Base URL and network connection.`,
    };
  }

  if (response.ok) {
    return {
      success: true,
      message: `Connected to OpenRouter (${config.model || 'no model selected'})`,
    };
  }

  const text = await response.text().catch(() => '');
  if (response.status === 401 || response.status === 403) {
    return {
      success: false,
      message: `Invalid API key or unauthorized (${response.status}). Check your OpenRouter key.`,
    };
  }
  return {
    success: false,
    message: `OpenRouter image connectivity failed (${response.status}): ${text}`,
  };
}

export async function generateWithOpenRouterImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = openRouterBaseUrl(config.baseUrl);
  const model = requireModel(config.model, 'OpenRouter Image');

  const body: Record<string, unknown> = { model, prompt: options.prompt, n: 1 };
  // `aspect_ratio` accepts our four ratios verbatim; omit it and the model decides.
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;

  const response = await imageProviderFetch(
    config,
    `${baseUrl}/images`,
    {
      method: 'POST',
      headers: openRouterHeaders(config.apiKey),
      // Never let a redirect carry the Authorization header to another host.
      redirect: 'manual',
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    { rejectRedirects: true },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter image generation failed (${response.status}): ${text}`);
  }

  const data: OpenRouterImageResponse = await response.json();
  if (data.error) {
    throw new Error(
      `OpenRouter error: ${data.error.code ?? ''} ${data.error.message ?? ''}`.trim(),
    );
  }

  const first = data.data?.[0];
  if (!first?.b64_json) {
    throw new Error('OpenRouter returned no image data');
  }

  const { width, height } = getDimensions(options.aspectRatio);
  // Return a data URL rather than bare `base64`. OpenRouter answers whatever the
  // upstream model produced — `output_format` accepts png, jpeg, webp and svg —
  // but the orchestration layer wraps a bare `base64` as `data:image/png`
  // unconditionally, which mislabels every non-PNG result. Carrying the reported
  // `media_type` in the URL keeps the bytes and their type together, and callers
  // already prefer `url` when present.
  const mediaType = first.media_type || 'image/png';
  return {
    url: `data:${mediaType};base64,${first.b64_json}`,
    base64: first.b64_json,
    width: options.width || width,
    height: options.height || height,
  };
}

// ============================================================================
// BYOK key probe (shared by the image and video capability routes)
// ============================================================================

/**
 * The fixed, read-only endpoint the probe may touch. One key covers every
 * hosted model, so a single key-metadata read verifies it — no request here can
 * spend the user's credits.
 */
const KEY_ENDPOINT = `${OPENROUTER_DEFAULT_BASE_URL}/key`;

const MAX_PROBE_BASE_URL_LENGTH = 128;

/**
 * The only base URL form a client may claim for the key probe.
 *
 * The probe never dials this value — it always calls {@link KEY_ENDPOINT} — but
 * accepting an arbitrary `x-base-url` would let the settings UI report a host
 * as verified that the probe never talked to. A missing header is fine: the
 * probe does not depend on it.
 */
export function isCanonicalOpenRouterBaseUrl(headerValue: string | null): boolean {
  if (headerValue === null) return true;
  if (!headerValue.trim() || headerValue.length > MAX_PROBE_BASE_URL_LENGTH) return false;

  try {
    const url = new URL(headerValue);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'openrouter.ai' &&
      !url.port &&
      !url.username &&
      !url.password &&
      (url.pathname === '/api/v1' || url.pathname === '/api/v1/') &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Operator-facing copy, kept apart so the two modalities can word it differently. */
export interface OpenRouterKeyProbeCopy {
  readonly connected: string;
  readonly invalidKey: string;
  readonly failed: string;
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Read the key's own metadata. Deliberately NOT the `/models` catalog: that
 * answers 200 unauthenticated, so probing it would report success for an
 * invalid key. The body is dropped on every path — `GET /key` answers key usage
 * metadata, which is not the caller's to read.
 *
 * A thrown request is an upstream error rather than a re-throw: the caller maps
 * outcomes onto one HTTP response, so a network failure and a `5xx` must not
 * take different paths through it.
 */
export async function probeOpenRouterKey(
  input: ProviderKeyProbeInput,
  copy: OpenRouterKeyProbeCopy,
): Promise<ProviderKeyProbeResult> {
  let response: Response;
  try {
    response = await input.transport.fetch(KEY_ENDPOINT, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    });
  } catch {
    return { outcome: 'upstream-error', message: copy.failed };
  }

  if (response.status >= 300 && response.status < 400) {
    await discardResponseBody(response);
    return { outcome: 'redirect', message: copy.failed };
  }
  await discardResponseBody(response);
  if (response.status === 401 || response.status === 403) {
    return { outcome: 'invalid-key', message: copy.invalidKey };
  }
  if (!response.ok) return { outcome: 'upstream-error', message: copy.failed };
  return { outcome: 'ok', message: copy.connected };
}

const IMAGE_KEY_PROBE_COPY: OpenRouterKeyProbeCopy = {
  connected: 'Connected to OpenRouter Image',
  invalidKey: 'OpenRouter API key is invalid',
  failed: 'OpenRouter image verification failed',
};

/** The key probe the image capability route resolves for this provider. */
export const OPENROUTER_IMAGE_KEY_PROBE: ProviderKeyProbe = {
  missingKeyMessage: 'An OpenRouter API key is required',
  rejectedBaseUrlMessage: 'OpenRouter base URL is not allowed',
  isBaseUrlAllowed: isCanonicalOpenRouterBaseUrl,
  probe: (input) => probeOpenRouterKey(input, IMAGE_KEY_PROBE_COPY),
};
