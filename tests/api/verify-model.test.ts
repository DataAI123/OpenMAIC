import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  consumeModelVerificationRateLimit: vi.fn(),
  UserApiRateLimitExceededError: class extends Error {
    retryAfterSeconds = 37;
  },
  createProviderVerificationTransport: vi.fn(),
  ProviderResponseTooLargeError: class extends Error {},
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
  parseModelString: vi.fn(),
  isServerConfiguredProvider: vi.fn(),
  resolveProxy: vi.fn(),
  allowLocalNetworksEnabled: vi.fn(),
  validatePublicUrlForSSRF: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeModelVerificationRateLimit: mocks.consumeModelVerificationRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/server/provider-verification-transport', () => ({
  createProviderVerificationTransport: mocks.createProviderVerificationTransport,
  ProviderResponseTooLargeError: mocks.ProviderResponseTooLargeError,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));
vi.mock('@/lib/ai/providers', () => ({
  parseModelString: mocks.parseModelString,
}));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveProxy: mocks.resolveProxy,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({
  allowLocalNetworksEnabled: mocks.allowLocalNetworksEnabled,
  validatePublicUrlForSSRF: mocks.validatePublicUrlForSSRF,
}));

async function postVerifyModel(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/verify-model/route');
  const request = new Request('http://localhost/api/verify-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/verify-model', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_req, handler) => handler('user:test-user', new Headers()));
    mocks.consumeModelVerificationRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.createProviderVerificationTransport.mockReset().mockReturnValue({
      fetch: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mocks.resolveModel.mockReset().mockResolvedValue({ model: { id: 'language-model' } });
    mocks.callLLM.mockReset().mockResolvedValue({ text: 'OK; echoed secret key' });
    mocks.parseModelString
      .mockReset()
      .mockReturnValue({ providerId: 'xiaomi', modelId: 'mimo-v2.5-pro' });
    mocks.isServerConfiguredProvider.mockReset().mockReturnValue(false);
    mocks.resolveProxy.mockReset().mockReturnValue(undefined);
    mocks.allowLocalNetworksEnabled.mockReset().mockReturnValue(false);
    mocks.validatePublicUrlForSSRF.mockReset().mockResolvedValue(null);
  });

  it('rejects requests without a model name', async () => {
    const res = await postVerifyModel({});
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ success: false, errorCode: 'MISSING_REQUIRED_FIELD' });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('requires an authenticated user and rate-limits before reaching the provider', async () => {
    mocks.withRequestOwnerId.mockImplementationOnce(async (_req, handler) =>
      handler('anon:legacy', new Headers()),
    );
    const anonymous = await postVerifyModel({ model: 'xiaomi:mimo-v2.5-pro' });
    expect(anonymous.status).toBe(401);
    expect(mocks.consumeModelVerificationRateLimit).not.toHaveBeenCalled();

    mocks.consumeModelVerificationRateLimit.mockRejectedValueOnce(
      new mocks.UserApiRateLimitExceededError(),
    );
    const limited = await postVerifyModel({ model: 'xiaomi:mimo-v2.5-pro' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('37');
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('uses owner-attributed LLM quota and bounded output without returning provider text', async () => {
    const res = await postVerifyModel({
      model: 'xiaomi:mimo-v2.5-pro',
      apiKey: 'user-key',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      providerType: 'openai',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, message: 'Connection successful' });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.consumeModelVerificationRateLimit).toHaveBeenCalledWith('user:test-user');
    expect(mocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelString: 'xiaomi:mimo-v2.5-pro',
        apiKey: 'user-key',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        providerType: 'openai',
        fetchImpl: expect.any(Function),
      }),
    );
    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: 'language-model' },
        prompt: 'Say "OK" if you can hear me.',
        maxOutputTokens: 32,
        abortSignal: expect.any(AbortSignal),
      }),
      'verify-model',
      undefined,
      { mode: 'disabled', enabled: false },
    );
  });

  it('rejects unsafe BYOK URLs and fails closed when rate-limit storage is unavailable', async () => {
    mocks.validatePublicUrlForSSRF.mockResolvedValueOnce('blocked');
    const blocked = await postVerifyModel({
      model: 'xiaomi:mimo-v2.5-pro',
      baseUrl: 'http://127.0.0.1:8080',
    });
    expect(blocked.status).toBe(400);
    expect(mocks.resolveModel).not.toHaveBeenCalled();

    mocks.validatePublicUrlForSSRF.mockResolvedValue(null);
    mocks.consumeModelVerificationRateLimit.mockRejectedValueOnce(new Error('database down'));
    const unavailable = await postVerifyModel({ model: 'xiaomi:mimo-v2.5-pro' });
    expect(unavailable.status).toBe(503);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('uses the server network policy for managed providers and sanitizes upstream errors', async () => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.allowLocalNetworksEnabled.mockReturnValue(true);
    mocks.callLLM.mockRejectedValueOnce(
      new Error('upstream included user-key https://secret.example/path'),
    );
    const res = await postVerifyModel({
      model: 'xiaomi:mimo-v2.5-pro',
      apiKey: 'user-key',
      baseUrl: 'http://127.0.0.1:8080',
    });
    const body = await res.text();
    expect(mocks.createProviderVerificationTransport).toHaveBeenCalledWith({
      allowLocalNetworks: true,
    });
    expect(body).not.toContain('user-key');
    expect(body).not.toContain('secret.example');
  });

  it('keeps proxy-routed providers closed until the proxy can enforce the verification target policy', async () => {
    mocks.resolveProxy.mockReturnValue('http://proxy.example.test:8080');
    const res = await postVerifyModel({ model: 'xiaomi:mimo-v2.5-pro' });
    expect(res.status).toBe(503);
    expect(mocks.createProviderVerificationTransport).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('rejects oversized JSON bodies before rate-limiting', async () => {
    const { POST } = await import('@/app/api/verify-model/route');
    const request = new Request('http://localhost/api/verify-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'xiaomi:mimo-v2.5-pro', apiKey: 'x'.repeat(20_000) }),
    });
    const res = await POST(request as unknown as NextRequest);
    expect(res.status).toBe(413);
    expect(mocks.consumeModelVerificationRateLimit).not.toHaveBeenCalled();
  });
});
