import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  validateUrlForSSRF: vi.fn(),
  withRequestOwnerId: vi.fn(),
  consumeProbeRateLimit: vi.fn(),
  fetchProviderModels: vi.fn(),
  UserApiRateLimitExceededError: class extends Error {
    retryAfterSeconds = 42;
  },
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validatePublicUrlForSSRF: mocks.validateUrlForSSRF,
}));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeProbeRateLimit: mocks.consumeProbeRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/server/provider-model-fetch', () => ({
  fetchProviderModels: mocks.fetchProviderModels,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postProbeModels(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/provider/probe-models/route');
  const request = new Request('http://localhost/api/provider/probe-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/provider/probe-models', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.validateUrlForSSRF.mockReset();
    mocks.validateUrlForSSRF.mockResolvedValue(null);
    mocks.consumeProbeRateLimit.mockReset();
    mocks.consumeProbeRateLimit.mockResolvedValue(undefined);
    mocks.withRequestOwnerId.mockReset();
    mocks.withRequestOwnerId.mockImplementation(async (_req, handler) =>
      handler('user:test-user', new Headers()),
    );
    mocks.fetchProviderModels.mockReset();
    mocks.fetchProviderModels.mockResolvedValue([{ id: 'chat-model', ownedBy: 'provider' }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('maps an upstream redirect to the exact redirect-not-allowed contract without reading it', async () => {
    const { ModelFetchError } = await import('@/lib/server/model-fetch');
    mocks.fetchProviderModels.mockRejectedValue(new ModelFetchError(302, 'redirect response body'));

    const res = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toEqual({
      success: false,
      errorCode: 'REDIRECT_NOT_ALLOWED',
      error: 'Redirects are not allowed',
    });
    expect(mocks.fetchProviderModels).toHaveBeenCalledTimes(1);
  });

  it('preserves successful model filtering and response metadata', async () => {
    mocks.fetchProviderModels.mockResolvedValue([
      { id: 'chat-model', ownedBy: 'provider' },
      { id: 'text-embedding-3-small', ownedBy: 'provider' },
    ]);

    const res = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      success: true,
      models: [{ id: 'chat-model', ownedBy: 'provider' }],
      total: 2,
      filtered: 1,
    });
  });

  it.each([401, 403])('preserves the API-key error contract for upstream %i', async (status) => {
    const { ModelFetchError } = await import('@/lib/server/model-fetch');
    mocks.fetchProviderModels.mockRejectedValue(new ModelFetchError(status, 'invalid key'));

    const res = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'bad-key',
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'API key is invalid or expired',
    });
  });

  it('preserves the manual-entry response when no model endpoint exists', async () => {
    const { ModelFetchError } = await import('@/lib/server/model-fetch');
    mocks.fetchProviderModels.mockRejectedValue(new ModelFetchError(404, 'not found'));

    const res = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'This provider does not expose a model list',
    });
  });

  it('applies a per-user rate limit before contacting the provider', async () => {
    mocks.consumeProbeRateLimit.mockRejectedValue(new mocks.UserApiRateLimitExceededError());
    const res = await postProbeModels({ baseUrl: 'https://api.example.com', apiKey: 'test-key' });
    expect(res.status).toBe(429);
    expect(mocks.fetchProviderModels).not.toHaveBeenCalled();
  });

  it('fails closed when the rate-limit store is unavailable', async () => {
    mocks.consumeProbeRateLimit.mockRejectedValue(new Error('database unavailable'));
    const res = await postProbeModels({ baseUrl: 'https://api.example.com', apiKey: 'test-key' });
    expect(res.status).toBe(503);
    expect(mocks.fetchProviderModels).not.toHaveBeenCalled();
  });

  it('does not treat a legacy anonymous owner as a person', async () => {
    mocks.withRequestOwnerId.mockImplementationOnce(async (_req, handler) =>
      handler('anon:legacy-owner', new Headers()),
    );
    const res = await postProbeModels({ baseUrl: 'https://api.example.com', apiKey: 'test-key' });
    expect(res.status).toBe(401);
    expect(mocks.consumeProbeRateLimit).not.toHaveBeenCalled();
    expect(mocks.fetchProviderModels).not.toHaveBeenCalled();
  });

  it('rejects unsafe targets and never includes upstream details in the response', async () => {
    mocks.validateUrlForSSRF.mockResolvedValue('Local network targets are not allowed');
    const res = await postProbeModels({ baseUrl: 'http://127.0.0.1:9000', apiKey: 'secret-key' });
    expect(res.status).toBe(400);
    expect(mocks.fetchProviderModels).not.toHaveBeenCalled();

    mocks.validateUrlForSSRF.mockResolvedValue(null);
    mocks.fetchProviderModels.mockRejectedValue(new Error('secret-key https://private/path'));
    const failed = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'secret-key',
    });
    const body = await failed.text();
    expect(body).not.toContain('secret-key');
    expect(body).not.toContain('private/path');
  });

  it('bounds DNS preflight time and fails closed when resolution stalls', async () => {
    vi.useFakeTimers();
    mocks.validateUrlForSSRF.mockReturnValue(new Promise(() => undefined));
    const response = postProbeModels({ baseUrl: 'https://slow-dns.example.com', apiKey: 'key' });
    await vi.advanceTimersByTimeAsync(5000);
    const res = await response;
    expect(res.status).toBe(400);
    expect(mocks.fetchProviderModels).not.toHaveBeenCalled();
  });

  it('rejects oversized request bodies before parsing or probing', async () => {
    const { POST } = await import('@/app/api/provider/probe-models/route');
    const request = new Request('http://localhost/api/provider/probe-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.example.com', apiKey: 'x'.repeat(20_000) }),
    });
    const res = await POST(request as unknown as NextRequest);
    expect(res.status).toBe(413);
    expect(mocks.fetchProviderModels).not.toHaveBeenCalled();
  });
});
