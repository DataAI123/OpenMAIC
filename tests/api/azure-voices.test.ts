import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  consumeAzureVoicesRateLimit: vi.fn(),
  fetch: vi.fn(),
  close: vi.fn(),
  UserApiRateLimitExceededError: class extends Error {
    retryAfterSeconds = 37;
  },
  validateUrlForSSRF: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeAzureVoicesRateLimit: mocks.consumeAzureVoicesRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/server/provider-verification-transport', () => ({
  createProviderVerificationTransport: vi.fn(() => ({
    fetch: mocks.fetch,
    close: mocks.close,
  })),
}));
vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: mocks.validateUrlForSSRF,
}));

async function postAzureVoices(body: unknown, headers?: Record<string, string>) {
  const { POST } = await import('@/app/api/azure-voices/route');
  const request = new Request('https://openmaic.example/api/azure-voices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/azure-voices', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.resetModules();
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_req, handler) => handler('user:test-user', new Headers()));
    mocks.consumeAzureVoicesRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.fetch
      .mockReset()
      .mockResolvedValue(Response.json([{ ShortName: 'en-US-AvaNeural', Locale: 'en-US' }]));
    mocks.close.mockReset().mockResolvedValue(undefined);
    mocks.validateUrlForSSRF.mockReset().mockResolvedValue(null);
  });

  it('uses a user-scoped limit and pinned public transport while preserving the voices response', async () => {
    const response = await postAzureVoices({
      baseUrl: 'https://eastus.tts.speech.microsoft.com/',
      apiKey: 'secret-test-key',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      voices: [{ ShortName: 'en-US-AvaNeural', Locale: 'en-US' }],
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.consumeAzureVoicesRateLimit).toHaveBeenCalledWith('user:test-user');
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list',
      expect.objectContaining({
        method: 'GET',
        headers: { 'Ocp-Apim-Subscription-Key': 'secret-test-key' },
      }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('rejects anonymous owners before rate limiting or upstream access', async () => {
    mocks.withRequestOwnerId.mockImplementationOnce(async (_req, handler) =>
      handler('anon:legacy-user', new Headers()),
    );

    const response = await postAzureVoices({
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      apiKey: 'secret-test-key',
    });
    expect(response.status).toBe(401);
    expect(mocks.consumeAzureVoicesRateLimit).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { baseUrl: 'http://eastus.tts.speech.microsoft.com', apiKey: 'key' },
    { baseUrl: 'https://attacker.example', apiKey: 'key' },
    { baseUrl: 'https://eastus.tts.speech.microsoft.com.attacker.example', apiKey: 'key' },
    { baseUrl: 'https://eastus.tts.speech.microsoft.com:8443', apiKey: 'key' },
    { baseUrl: 'https://eastus.tts.speech.microsoft.com/attacker', apiKey: 'key' },
    { baseUrl: 'https://user:pass@eastus.tts.speech.microsoft.com', apiKey: 'key' },
    { baseUrl: 'https://eastus.tts.speech.microsoft.com?token=secret', apiKey: 'key' },
    { baseUrl: 'https://eastus.tts.speech.microsoft.com', apiKey: '' },
  ])('rejects unsafe or incomplete input before rate limiting', async (body) => {
    const response = await postAzureVoices(body);
    expect(response.status).toBe(400);
    expect(mocks.consumeAzureVoicesRateLimit).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('uses the documented voice-list path for Azure resource endpoints', async () => {
    await postAzureVoices({
      baseUrl: 'https://my-speech-resource.cognitiveservices.azure.com',
      apiKey: 'secret-test-key',
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://my-speech-resource.cognitiveservices.azure.com/tts/cognitiveservices/voices/list',
      expect.any(Object),
    );
  });

  it('preserves legacy support for a custom endpoint without using the OIDC-only limiter', async () => {
    mocks.withRequestOwnerId.mockImplementationOnce(async (_req, handler) =>
      handler('anon:legacy-user', new Headers()),
    );
    vi.stubGlobal('fetch', mocks.fetch);

    const response = await postAzureVoices({
      baseUrl: 'https://speech-proxy.example.test/custom/path',
      apiKey: 'legacy-key',
    });

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://speech-proxy.example.test/custom/path/cognitiveservices/voices/list',
      expect.any(Object),
    );
    expect(mocks.validateUrlForSSRF).toHaveBeenCalledWith(
      'https://speech-proxy.example.test/custom/path',
    );
    expect(mocks.consumeAzureVoicesRateLimit).not.toHaveBeenCalled();
  });

  it('does not echo legacy upstream errors that may contain BYOK data', async () => {
    mocks.withRequestOwnerId.mockImplementationOnce(async (_req, handler) =>
      handler('anon:legacy-user', new Headers()),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('upstream rejected secret=legacy-key', { status: 401 })),
    );

    const response = await postAzureVoices({
      baseUrl: 'https://speech-proxy.example.test',
      apiKey: 'legacy-key',
    });

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain('legacy-key');
    expect(body).not.toContain('upstream rejected');
  });

  it('rejects oversized requests', async () => {
    const response = await postAzureVoices({
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      apiKey: 'k'.repeat(20_000),
    });
    expect(response.status).toBe(413);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('returns rate limit retry information without contacting Azure', async () => {
    mocks.consumeAzureVoicesRateLimit.mockRejectedValue(new mocks.UserApiRateLimitExceededError());
    const response = await postAzureVoices({
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      apiKey: 'secret-test-key',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('37');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the rate-limit database is unavailable', async () => {
    mocks.consumeAzureVoicesRateLimit.mockRejectedValue(new Error('database unavailable'));
    const response = await postAzureVoices({
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      apiKey: 'secret-test-key',
    });
    expect(response.status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('normalizes upstream and invalid response failures without leaking credentials', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('request to https://host/?secret=key failed'));
    const failed = await postAzureVoices({
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      apiKey: 'secret-test-key',
    });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret-test-key');

    mocks.fetch.mockResolvedValueOnce(Response.json({ error: 'not a voice list' }));
    const invalid = await postAzureVoices({
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      apiKey: 'secret-test-key',
    });
    expect(invalid.status).toBe(502);
  });
});
