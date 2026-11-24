import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  withRequestOwnerId: vi.fn(),
  consumeImageProviderVerificationRateLimit: vi.fn(),
  createProviderVerificationTransport: vi.fn(),
  legacyConnectivity: vi.fn(),
  isServerConfiguredProvider: vi.fn(),
  isServerProviderDisabled: vi.fn(),
  resolveServerImageProviderId: vi.fn(),
  resolveImageApiKey: vi.fn(),
  resolveImageBaseUrl: vi.fn(),
  resolveImageModel: vi.fn(),
  UserApiRateLimitExceededError: class extends Error {
    retryAfterSeconds = 29;
  },
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeImageProviderVerificationRateLimit: mocks.consumeImageProviderVerificationRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/server/provider-verification-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-verification-transport')>()),
  createProviderVerificationTransport: mocks.createProviderVerificationTransport,
}));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  isServerProviderDisabled: mocks.isServerProviderDisabled,
  resolveServerImageProviderId: mocks.resolveServerImageProviderId,
  resolveImageApiKey: mocks.resolveImageApiKey,
  resolveImageBaseUrl: mocks.resolveImageBaseUrl,
  resolveImageModel: mocks.resolveImageModel,
}));
vi.mock('@/lib/media/image-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media/image-providers')>()),
  IMAGE_PROVIDERS: {
    'openrouter-image': { requiresApiKey: true, models: [{ id: 'image-model' }] },
  },
  testImageConnectivity: mocks.legacyConnectivity,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeRequest(headers: Record<string, string> = {}, body?: string): NextRequest {
  return new Request('https://app.example.com/api/verify-image-provider', {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body }),
  }) as unknown as NextRequest;
}

async function post(headers: Record<string, string> = {}, body?: string) {
  const { POST } = await import('@/app/api/verify-image-provider/route');
  return POST(makeRequest(headers, body));
}

describe('POST /api/verify-image-provider OIDC slice', () => {
  let upstreamFetch: ReturnType<typeof vi.fn>;
  let closeTransport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc' });
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_request, handler) => handler('user:alice', new Headers()));
    mocks.consumeImageProviderVerificationRateLimit.mockReset().mockResolvedValue(undefined);
    upstreamFetch = vi.fn().mockResolvedValue(new Response('sensitive key usage metadata'));
    closeTransport = vi.fn().mockResolvedValue(undefined);
    mocks.createProviderVerificationTransport.mockReset().mockReturnValue({
      fetch: upstreamFetch,
      close: closeTransport,
    });
    mocks.legacyConnectivity.mockReset().mockResolvedValue({ success: true, message: 'legacy' });
    mocks.isServerConfiguredProvider.mockReset().mockReturnValue(false);
    mocks.isServerProviderDisabled.mockReset().mockReturnValue(false);
    mocks.resolveServerImageProviderId.mockReset().mockReturnValue('openrouter-image');
    mocks.resolveImageApiKey.mockReset().mockReturnValue('server-managed-key');
    mocks.resolveImageBaseUrl.mockReset().mockReturnValue('https://server.example.test');
    mocks.resolveImageModel.mockReset().mockReturnValue('image-model');
  });

  it('uses only the fixed read-only OpenRouter key endpoint and never returns key metadata', async () => {
    const response = await post({
      'x-image-provider': 'openrouter-image',
      'x-api-key': 'user-owned-key',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message: 'Connected to OpenRouter Image',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.consumeImageProviderVerificationRateLimit).toHaveBeenCalledWith('user:alice');
    expect(mocks.createProviderVerificationTransport).toHaveBeenCalledWith({
      allowLocalNetworks: false,
      followRedirects: false,
    });
    expect(upstreamFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: { Authorization: 'Bearer user-owned-key' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(closeTransport).toHaveBeenCalledOnce();
    expect(mocks.legacyConnectivity).not.toHaveBeenCalled();
    expect(await response.text().catch(() => '')).not.toContain('sensitive key usage metadata');
  });

  it('requires a database-backed user and does not spend rate limit on anonymous owners', async () => {
    mocks.withRequestOwnerId.mockImplementationOnce(async (_request, handler) =>
      handler('anon:legacy', new Headers()),
    );

    const response = await post({
      'x-image-provider': 'openrouter-image',
      'x-api-key': 'user-owned-key',
    });

    expect(response.status).toBe(401);
    expect(mocks.consumeImageProviderVerificationRateLimit).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects providers that may generate an image and never calls their legacy probe', async () => {
    const response = await post({ 'x-image-provider': 'seedream', 'x-api-key': 'user-owned-key' });

    expect(response.status).toBe(503);
    expect(mocks.legacyConnectivity).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects missing BYOK credentials without falling back to the server key', async () => {
    const response = await post({ 'x-image-provider': 'openrouter-image' });

    expect(response.status).toBe(400);
    expect(mocks.resolveImageApiKey).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1:8080',
    'https://other.example.test/api/v1',
    'https://openrouter.ai/api/v1?redirect=http://127.0.0.1',
  ])('rejects a noncanonical provider base URL: %s', async (baseUrl) => {
    const response = await post({
      'x-image-provider': 'openrouter-image',
      'x-api-key': 'user-owned-key',
      'x-base-url': baseUrl,
    });

    expect(response.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects request bodies because the probe accepts headers only', async () => {
    const response = await post(
      { 'x-image-provider': 'openrouter-image', 'x-api-key': 'user-owned-key' },
      JSON.stringify({ prompt: 'bill me' }),
    );

    expect(response.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('maps redirects to a stable error and closes the pinned transport', async () => {
    upstreamFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://other.example.test' } }),
    );

    const response = await post({
      'x-image-provider': 'openrouter-image',
      'x-api-key': 'user-owned-key',
    });
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).not.toContain('other.example.test');
    expect(closeTransport).toHaveBeenCalledOnce();
  });

  it('fails closed on database rate-limit failure and honors retry-after when limited', async () => {
    mocks.consumeImageProviderVerificationRateLimit.mockRejectedValueOnce(
      new Error('database down'),
    );
    const unavailable = await post({
      'x-image-provider': 'openrouter-image',
      'x-api-key': 'user-owned-key',
    });
    expect(unavailable.status).toBe(503);
    expect(upstreamFetch).not.toHaveBeenCalled();

    mocks.consumeImageProviderVerificationRateLimit.mockRejectedValueOnce(
      new mocks.UserApiRateLimitExceededError(),
    );
    const limited = await post({
      'x-image-provider': 'openrouter-image',
      'x-api-key': 'user-owned-key',
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('29');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('retains the legacy provider path and correlates its response outside OIDC mode', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const response = await post({
      'x-image-provider': 'openrouter-image',
      'x-request-id': 'image-legacy-probe',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('image-legacy-probe');
    expect(mocks.legacyConnectivity).toHaveBeenCalledOnce();
    expect(mocks.consumeImageProviderVerificationRateLimit).not.toHaveBeenCalled();
  });

  it('returns a correlated sanitized error when auth configuration is unavailable', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('private configuration details');
    });

    const response = await post({ 'x-request-id': 'image-auth-config-failure' });

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('image-auth-config-failure');
    const body = await response.text();
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toContain('private configuration details');
  });
});
