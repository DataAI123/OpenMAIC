import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { createProviderVerificationTransport } from '@/lib/server/provider-verification-transport';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  consumeAzureVoicesRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 8192;
const REQUEST_TIMEOUT_MS = 15_000;
const AZURE_SPEECH_HOST_SUFFIXES = [
  '.tts.speech.microsoft.com',
  '.tts.speech.azure.us',
  '.tts.speech.azure.cn',
  '.cognitiveservices.azure.com',
  '.cognitiveservices.azure.us',
  '.cognitiveservices.azure.cn',
] as const;
const log = createLogger('Azure Voices');

export const maxDuration = 30;

interface AzureVoicesRequest {
  baseUrl: string;
  apiKey: string;
}

class RequestBodyTooLargeError extends Error {}

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

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function isAzureSpeechEndpoint(hostname: string): boolean {
  return AZURE_SPEECH_HOST_SUFFIXES.some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
}

function validateBody(value: unknown): AzureVoicesRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Request must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
    throw new TypeError('API key is required');
  }
  if (body.apiKey.length > MAX_API_KEY_LENGTH) throw new TypeError('API key is too long');
  if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
    throw new TypeError('Base URL is required');
  }
  if (body.baseUrl.length > MAX_URL_LENGTH) throw new TypeError('Base URL is too long');

  let url: URL;
  try {
    url = new URL(body.baseUrl.trim());
  } catch {
    throw new TypeError('Base URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    url.pathname !== '/' ||
    !isAzureSpeechEndpoint(url.hostname)
  ) {
    throw new TypeError('Base URL is invalid');
  }

  return { apiKey: body.apiKey, baseUrl: url.toString().replace(/\/$/, '') };
}

function voicesListUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const isResourceEndpoint = [
    '.cognitiveservices.azure.com',
    '.cognitiveservices.azure.us',
    '.cognitiveservices.azure.cn',
  ].some((suffix) => url.hostname.endsWith(suffix));
  const path = isResourceEndpoint
    ? '/tts/cognitiveservices/voices/list'
    : '/cognitiveservices/voices/list';
  return new URL(path, url.origin).toString();
}

async function legacyPost(req: NextRequest): Promise<Response> {
  let baseUrl: string | undefined;
  try {
    const body = await req.json();
    const { apiKey } = body;
    baseUrl = body.baseUrl;

    if (!apiKey) return apiError('MISSING_API_KEY', 400, 'API Key is required');
    if (!baseUrl) return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');

    const ssrfError = await validateUrlForSSRF(baseUrl);
    if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);

    const response = await fetch(`${baseUrl}/cognitiveservices/voices/list`, {
      method: 'GET',
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }
    if (!response.ok) {
      return apiError('UPSTREAM_ERROR', response.status, 'Failed to fetch voices from Azure');
    }
    return apiSuccess({ voices: await response.json() });
  } catch (error) {
    log.error('Azure voices fetch failed', error instanceof Error ? error.name : 'UnknownError');
    return apiError('INTERNAL_ERROR', 500, 'Failed to fetch voices');
  }
}

/** Authenticated BYOK lookup of Azure Speech voices; this endpoint does not synthesize audio. */
export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    if (!ownerId.startsWith('user:')) return legacyPost(req);
    responseHeaders.set('Cache-Control', 'private, no-store');
    if (ownerId.length === 'user:'.length) {
      return ownerApiError('UNAUTHENTICATED', 401, 'Login is required', responseHeaders);
    }

    let body: AzureVoicesRequest;
    try {
      body = validateBody(await readJsonBody(req));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return ownerApiError('INVALID_REQUEST', 413, 'Request body is too large', responseHeaders);
      }
      return ownerApiError('INVALID_REQUEST', 400, 'Invalid Azure voice request', responseHeaders);
    }

    try {
      await consumeAzureVoicesRateLimit(ownerId);
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return ownerApiError('RATE_LIMITED', 429, 'Too many voice-list requests', responseHeaders);
      }
      return ownerApiError('INTERNAL_ERROR', 503, 'Voice lookup is unavailable', responseHeaders);
    }

    const transport = createProviderVerificationTransport({ allowLocalNetworks: false });
    try {
      const response = await transport.fetch(voicesListUrl(body.baseUrl), {
        method: 'GET',
        headers: { 'Ocp-Apim-Subscription-Key': body.apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        return ownerApiError('UPSTREAM_ERROR', 502, 'Azure voice lookup failed', responseHeaders);
      }
      if (!response.ok) {
        return ownerApiError('UPSTREAM_ERROR', 502, 'Azure voice lookup failed', responseHeaders);
      }

      const voices: unknown = await response.json();
      if (!Array.isArray(voices)) {
        return ownerApiError('UPSTREAM_ERROR', 502, 'Azure voice lookup failed', responseHeaders);
      }
      return ownerJson({ success: true, voices }, 200, responseHeaders);
    } catch {
      return ownerApiError('UPSTREAM_ERROR', 502, 'Azure voice lookup failed', responseHeaders);
    } finally {
      await transport.close();
    }
  });
}
