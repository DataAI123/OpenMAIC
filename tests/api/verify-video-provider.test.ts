import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  withRequestOwnerId: vi.fn(),
  consumeVideoProviderVerificationRateLimit: vi.fn(),
  createProviderVerificationTransport: vi.fn(),
  legacyConnectivity: vi.fn(),
  isServerProviderDisabled: vi.fn(),
  UserApiRateLimitExceededError: class extends Error {
    retryAfterSeconds = 29;
  },
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeVideoProviderVerificationRateLimit: mocks.consumeVideoProviderVerificationRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/server/provider-verification-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-verification-transport')>()),
  createProviderVerificationTransport: mocks.createProviderVerificationTransport,
}));
vi.mock('@/lib/server/provider-config', () => ({
  isServerProviderDisabled: mocks.isServerProviderDisabled,
  isServerConfiguredProvider: vi.fn(() => false),
  resolveServerVideoProviderId: vi.fn(() => 'openrouter-video'),
  resolveVideoApiKey: vi.fn(() => 'server-managed-key'),
  resolveVideoBaseUrl: vi.fn(() => 'https://server.example.test'),
  resolveVideoModel: vi.fn(() => 'video-model'),
}));
vi.mock('@/lib/media/video-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media/video-providers')>()),
  testVideoConnectivity: mocks.legacyConnectivity,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeRequest(headers: Record<string, string> = {}, body?: string): NextRequest {
  return new Request('https://app.example.com/api/verify-video-provider', {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body }),
  }) as unknown as NextRequest;
}

async function post(headers: Record<string, string> = {}, body?: string) {
  const { POST } = await import('@/app/api/verify-video-provider/route');
  return POST(makeRequest(headers, body));
}

describe('POST /api/verify-video-provider OIDC OpenRouter slice', () => {
  let upstreamFetch: ReturnType<typeof vi.fn>;
  let closeTransport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc' });
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_request, handler) => handler('user:alice', new Headers()));
    mocks.consumeVideoProviderVerificationRateLimit.mockReset().mockResolvedValue(undefined);
    upstreamFetch = vi.fn().mockResolvedValue(new Response('sensitive key usage metadata'));
    closeTransport = vi.fn().mockResolvedValue(undefined);
    mocks.createProviderVerificationTransport.mockReset().mockReturnValue({
      fetch: upstreamFetch,
      close: closeTransport,
    });
    mocks.legacyConnectivity.mockReset().mockResolvedValue({ success: true, message: 'legacy' });
    mocks.isServerProviderDisabled.mockReset().mockReturnValue(false);
  });

  it('uses only the fixed read-only OpenRouter key endpoint and hides upstream metadata', async () => {
    const response = await post({
      'x-video-provider': 'openrouter-video',
      'x-api-key': 'user-owned-key',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message: 'Connected to OpenRouter Video',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.consumeVideoProviderVerificationRateLimit).toHaveBeenCalledWith('user:alice');
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
  });

  it('rejects anonymous owners and generation providers before rate or upstream work', async () => {
    mocks.withRequestOwnerId.mockImplementationOnce(async (_request, handler) =>
      handler('anon:legacy', new Headers()),
    );
    const anonymous = await post({ 'x-video-provider': 'openrouter-video', 'x-api-key': 'byok' });
    expect(anonymous.status).toBe(401);

    const generation = await post({ 'x-video-provider': 'veo', 'x-api-key': 'byok' });
    expect(generation.status).toBe(503);
    expect(mocks.consumeVideoProviderVerificationRateLimit).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(mocks.legacyConnectivity).not.toHaveBeenCalled();
  });

  it.each([
    ['missing key', { 'x-video-provider': 'openrouter-video' }],
    [
      'noncanonical URL',
      {
        'x-video-provider': 'openrouter-video',
        'x-api-key': 'byok',
        'x-base-url': 'https://other.example.test/api/v1',
      },
    ],
  ])('rejects %s without calling upstream', async (_label, headers) => {
    const response = await post(headers);
    expect(response.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('rejects request bodies and redirects, and closes the transport', async () => {
    const bodyResponse = await post(
      { 'x-video-provider': 'openrouter-video', 'x-api-key': 'byok' },
      JSON.stringify({ prompt: 'generate a paid clip' }),
    );
    expect(bodyResponse.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();

    upstreamFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://other.example.test' } }),
    );
    const redirectResponse = await post({
      'x-video-provider': 'openrouter-video',
      'x-api-key': 'byok',
    });
    expect(redirectResponse.status).toBe(403);
    expect(await redirectResponse.text()).not.toContain('other.example.test');
    expect(closeTransport).toHaveBeenCalledOnce();
  });

  it('fails closed when rate storage is unavailable and honors retry-after', async () => {
    mocks.consumeVideoProviderVerificationRateLimit.mockRejectedValueOnce(
      new Error('database down'),
    );
    const unavailable = await post({ 'x-video-provider': 'openrouter-video', 'x-api-key': 'byok' });
    expect(unavailable.status).toBe(503);
    expect(upstreamFetch).not.toHaveBeenCalled();

    mocks.consumeVideoProviderVerificationRateLimit.mockRejectedValueOnce(
      new mocks.UserApiRateLimitExceededError(),
    );
    const limited = await post({ 'x-video-provider': 'openrouter-video', 'x-api-key': 'byok' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('29');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('retains the legacy path outside OIDC mode', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    const response = await post({
      'x-video-provider': 'openrouter-video',
      'x-request-id': 'video-legacy-probe',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('video-legacy-probe');
    expect(mocks.legacyConnectivity).toHaveBeenCalledOnce();
    expect(mocks.consumeVideoProviderVerificationRateLimit).not.toHaveBeenCalled();
  });

  it('returns a correlated sanitized error when auth configuration is unavailable', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('private configuration details');
    });

    const response = await post({ 'x-request-id': 'video-auth-config-failure' });

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('video-auth-config-failure');
    const body = await response.text();
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toContain('private configuration details');
  });
});
