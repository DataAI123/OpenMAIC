import type { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { parseModelString } from '@/lib/ai/providers';
import { ownerApiError, ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { allowLocalNetworksEnabled, validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
import { resolveModel } from '@/lib/server/resolve-model';
import { isServerConfiguredProvider, resolveProxy } from '@/lib/server/provider-config';
import {
  createProviderVerificationTransport,
  ProviderResponseTooLargeError,
} from '@/lib/server/provider-verification-transport';
import {
  consumeModelVerificationRateLimit,
  UserApiRateLimitExceededError,
} from '@/lib/server/user-api-rate-limit';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_MODEL_LENGTH = 256;
const MAX_API_KEY_LENGTH = 8192;
const MAX_BASE_URL_LENGTH = 2048;
const DNS_VALIDATION_TIMEOUT_MS = 5000;
const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_OUTPUT_TOKENS = 32;

interface VerifyModelBody {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
}

class RequestBodyTooLargeError extends Error {}
class ModelRequiredError extends Error {}

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

function validateBody(value: unknown): VerifyModelBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid verification request');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.model !== 'string' || !body.model.trim()) throw new ModelRequiredError();
  if (body.model.length > MAX_MODEL_LENGTH) throw new TypeError('Model is too long');
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
    throw new TypeError('API key must be a string');
  }
  if (typeof body.apiKey === 'string' && body.apiKey.length > MAX_API_KEY_LENGTH) {
    throw new TypeError('API key is too long');
  }
  if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
    throw new TypeError('Base URL must be a string');
  }
  if (typeof body.baseUrl === 'string' && body.baseUrl.length > MAX_BASE_URL_LENGTH) {
    throw new TypeError('Base URL is too long');
  }
  if (body.providerType !== undefined && typeof body.providerType !== 'string') {
    throw new TypeError('Provider type must be a string');
  }
  if (typeof body.providerType === 'string' && body.providerType.length > 32) {
    throw new TypeError('Provider type is too long');
  }
  return {
    model: body.model.trim(),
    ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
    ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl.trim() } : {}),
    ...(typeof body.providerType === 'string' ? { providerType: body.providerType } : {}),
  };
}

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

function containsMessage(error: unknown, prefix: string): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (typeof current === 'string') {
      if (current.includes(prefix)) return true;
      continue;
    }
    if (typeof current !== 'object') continue;
    const record = current as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (
      record.name === prefix ||
      (typeof record.message === 'string' && record.message.includes(prefix))
    ) {
      return true;
    }
    pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return false;
}

/**
 * POST /api/verify-model
 * Performs one small, owner-attributed LLM check using managed provider policy
 * or a user's BYOK credentials. No provider response or credential is returned.
 */
export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    responseHeaders.set('Cache-Control', 'private, no-store');
    if (!ownerId.startsWith('user:') || ownerId.length === 'user:'.length) {
      return ownerApiError('UNAUTHENTICATED', 401, 'Login is required', responseHeaders);
    }

    let body: VerifyModelBody;
    try {
      body = validateBody(await readJsonBody(req));
    } catch (error) {
      if (error instanceof ModelRequiredError) {
        return ownerApiError(
          'MISSING_REQUIRED_FIELD',
          400,
          'Model name is required',
          responseHeaders,
        );
      }
      return error instanceof RequestBodyTooLargeError
        ? ownerApiError('INVALID_REQUEST', 413, 'Request body is too large', responseHeaders)
        : ownerApiError(
            'INVALID_REQUEST',
            400,
            'Invalid model verification request',
            responseHeaders,
          );
    }

    try {
      await consumeModelVerificationRateLimit(ownerId);
    } catch (error) {
      if (error instanceof UserApiRateLimitExceededError) {
        responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
        return ownerApiError('RATE_LIMITED', 429, 'Too many model verifications', responseHeaders);
      }
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'Verification service is unavailable',
        responseHeaders,
      );
    }

    let parsedModel: ReturnType<typeof parseModelString>;
    try {
      parsedModel = parseModelString(body.model);
    } catch {
      return ownerApiError(
        'INVALID_REQUEST',
        400,
        'Model specification is invalid',
        responseHeaders,
      );
    }
    const managed = isServerConfiguredProvider('providers', parsedModel.providerId);
    if (resolveProxy(parsedModel.providerId)) {
      return ownerApiError(
        'INTERNAL_ERROR',
        503,
        'Verification is unavailable for proxy-routed providers',
        responseHeaders,
      );
    }
    if (!managed && body.baseUrl) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(body.baseUrl);
      } catch {
        return ownerApiError('INVALID_REQUEST', 400, 'Provider URL is invalid', responseHeaders);
      }
      if (parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
        return ownerApiError('INVALID_REQUEST', 400, 'Provider URL is invalid', responseHeaders);
      }
      if (await validateProbeTarget(body.baseUrl)) {
        return ownerApiError(
          'INVALID_REQUEST',
          400,
          'Provider URL is not allowed',
          responseHeaders,
        );
      }
    }

    const transport = createProviderVerificationTransport({
      allowLocalNetworks: managed && allowLocalNetworksEnabled(),
    });
    try {
      let resolvedModel;
      try {
        resolvedModel = await resolveModel({
          modelString: body.model,
          apiKey: body.apiKey ?? '',
          baseUrl: body.baseUrl || undefined,
          providerType: body.providerType,
          fetchImpl: transport.fetch,
        });
      } catch {
        return ownerApiError(
          'INVALID_REQUEST',
          400,
          'Model or provider configuration is invalid',
          responseHeaders,
        );
      }

      try {
        await callLLM(
          {
            model: resolvedModel.model,
            prompt: 'Say "OK" if you can hear me.',
            maxOutputTokens: VERIFY_OUTPUT_TOKENS,
            abortSignal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
          },
          'verify-model',
          undefined,
          { mode: 'disabled', enabled: false },
        );
      } catch (error) {
        if (containsMessage(error, 'PERSONAL_LLM_MONTHLY_QUOTA_EXCEEDED')) {
          return ownerApiError('RATE_LIMITED', 429, 'Personal LLM quota exceeded', responseHeaders);
        }
        if (containsMessage(error, 'PERSONAL_LLM_QUOTA_')) {
          return ownerApiError(
            'INTERNAL_ERROR',
            503,
            'Personal LLM quota is unavailable',
            responseHeaders,
          );
        }
        if (
          error instanceof ProviderResponseTooLargeError ||
          containsMessage(error, 'Provider verification response exceeded its limit')
        ) {
          return ownerApiError(
            'UPSTREAM_ERROR',
            502,
            'Provider response is too large',
            responseHeaders,
          );
        }
        if (
          (error instanceof DOMException && error.name === 'TimeoutError') ||
          containsMessage(error, 'TimeoutError')
        ) {
          return ownerApiError(
            'UPSTREAM_ERROR',
            504,
            'Provider verification timed out',
            responseHeaders,
          );
        }
        return ownerApiError(
          'UPSTREAM_ERROR',
          502,
          'Provider verification failed',
          responseHeaders,
        );
      }

      return ownerJson({ success: true, message: 'Connection successful' }, 200, responseHeaders);
    } finally {
      await transport.close().catch(() => undefined);
    }
  });
}
