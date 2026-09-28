import type { NextRequest } from 'next/server';

import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { ModelFetchError } from '@/lib/server/model-fetch';
import { fetchProviderModels } from '@/lib/server/provider-model-fetch';
import { validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  consumeProbeRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 8192;
const DNS_VALIDATION_TIMEOUT_MS = 5000;

/** Model ids that are not chat models — filtered out of probe results. */
const NON_CHAT_PATTERN = /(tts|asr|whisper|embedding|rerank|mineru|image|video|voxcpm|moderation)/i;

interface ProbeRequestBody {
  baseUrl: string;
  apiKey?: string;
  modelsUrl?: string;
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

class RequestBodyTooLargeError extends Error {}

async function validateProbeTarget(url: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    validatePublicUrlForSSRF(url).catch(() => 'Unable to verify hostname safety'),
    new Promise<string>((resolve) => {
      timer = setTimeout(
        () => resolve('Unable to verify hostname safety'),
        DNS_VALIDATION_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer!));
}

function validateBody(value: unknown): ProbeRequestBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Request must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
    throw new TypeError('baseUrl is required');
  }
  if (body.baseUrl.length > MAX_URL_LENGTH) throw new TypeError('baseUrl is too long');
  if (body.modelsUrl !== undefined && typeof body.modelsUrl !== 'string') {
    throw new TypeError('modelsUrl must be a string');
  }
  if (typeof body.modelsUrl === 'string' && body.modelsUrl.length > MAX_URL_LENGTH) {
    throw new TypeError('modelsUrl is too long');
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
    throw new TypeError('apiKey must be a string');
  }
  if (typeof body.apiKey === 'string' && body.apiKey.length > MAX_API_KEY_LENGTH) {
    throw new TypeError('apiKey is too long');
  }
  for (const candidate of [body.baseUrl, body.modelsUrl].filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  )) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new TypeError('Provider URL is invalid');
    }
    if (url.username || url.password || url.hash) throw new TypeError('Provider URL is invalid');
  }
  return {
    baseUrl: body.baseUrl.trim(),
    ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
    ...(typeof body.modelsUrl === 'string' ? { modelsUrl: body.modelsUrl.trim() } : {}),
  };
}

/**
 * POST /api/provider/probe-models
 * Authenticated BYOK model discovery. Each request is owner-attributed,
 * rate-limited, restricted to public endpoints, and bounded in both directions.
 */
export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    responseHeaders.set('Cache-Control', 'private, no-store');
    try {
      if (!ownerId.startsWith('user:') || ownerId.length === 'user:'.length) {
        return ownerApiError('UNAUTHENTICATED', 401, 'Login is required', responseHeaders);
      }

      let body: ProbeRequestBody;
      try {
        body = validateBody(await readJsonBody(req));
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return ownerApiError(
            'INVALID_REQUEST',
            413,
            'Request body is too large',
            responseHeaders,
          );
        }
        return ownerApiError('INVALID_REQUEST', 400, 'Invalid probe request', responseHeaders);
      }

      try {
        await consumeProbeRateLimit(ownerId);
      } catch (error) {
        if (error instanceof UserApiRateLimitExceededError) {
          responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
          return ownerApiError('RATE_LIMITED', 429, 'Too many model probes', responseHeaders);
        }
        return ownerApiError(
          'INTERNAL_ERROR',
          503,
          'Probe service is unavailable',
          responseHeaders,
        );
      }

      const targets = [body.baseUrl, body.modelsUrl].filter(Boolean) as string[];
      const ssrfErrors = await Promise.all(targets.map(validateProbeTarget));
      for (const ssrfError of ssrfErrors) {
        if (ssrfError)
          return ownerApiError(
            'INVALID_REQUEST',
            400,
            'Provider URL is not allowed',
            responseHeaders,
          );
      }

      const models = await fetchProviderModels(body.baseUrl, body.apiKey ?? '', {
        modelsUrlOverride: body.modelsUrl,
      });
      const chatModels = models.filter((model) => !NON_CHAT_PATTERN.test(model.id));
      return ownerJson(
        {
          success: true,
          models: chatModels.map((model) => ({ id: model.id, ownedBy: model.ownedBy })),
          total: models.length,
          filtered: models.length - chatModels.length,
        },
        200,
        responseHeaders,
      );
    } catch (error) {
      if (error instanceof ModelFetchError) {
        if (error.status >= 300 && error.status < 400) {
          return ownerApiError(
            'REDIRECT_NOT_ALLOWED',
            403,
            'Redirects are not allowed',
            responseHeaders,
          );
        }
        if (error.status === 401 || error.status === 403) {
          return ownerApiError(
            'INVALID_REQUEST',
            401,
            'API key is invalid or expired',
            responseHeaders,
          );
        }
        if (error.status === 404) {
          return ownerApiError(
            'INVALID_REQUEST',
            404,
            'This provider does not expose a model list',
            responseHeaders,
          );
        }
        return ownerApiError(
          'INTERNAL_ERROR',
          502,
          'Provider model discovery failed',
          responseHeaders,
        );
      }
      // Do not log exception text: undici errors may contain a user-supplied URL.
      return ownerApiError(
        'INTERNAL_ERROR',
        502,
        'Provider model discovery failed',
        responseHeaders,
      );
    }
  });
}
