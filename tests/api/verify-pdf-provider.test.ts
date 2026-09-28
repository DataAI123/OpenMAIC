import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolveManagedAliDocMindCredentials: vi.fn(),
  resolvePDFApiKey: vi.fn(),
  resolvePDFBaseUrl: vi.fn(),
  validateUrlForSSRF: vi.fn(),
  validateUrlForSSRFWithPolicy: vi.fn(),
  allowLocalNetworksEnabled: vi.fn(),
  resolveAuthConfig: vi.fn(),
  withRequestOwnerId: vi.fn(),
  consumePdfProviderVerificationRateLimit: vi.fn(),
  verifyAliDocMindCredentials: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials: mocks.resolveManagedAliDocMindCredentials,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: mocks.validateUrlForSSRF,
  validateUrlForSSRFWithPolicy: mocks.validateUrlForSSRFWithPolicy,
  allowLocalNetworksEnabled: mocks.allowLocalNetworksEnabled,
}));
vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumePdfProviderVerificationRateLimit: mocks.consumePdfProviderVerificationRateLimit,
  UserApiRateLimitExceededError: class UserApiRateLimitExceededError extends Error {
    constructor(public retryAfterSeconds: number) {
      super('Rate limited');
    }
  },
}));
vi.mock('@/lib/pdf/alidocmind-client', () => ({
  verifyAliDocMindCredentials: mocks.verifyAliDocMindCredentials,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postVerifyPdfProvider(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const { POST } = await import('@/app/api/verify-pdf-provider/route');
  const request = new Request('http://localhost/api/verify-pdf-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/verify-pdf-provider', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isServerConfiguredProvider.mockReset();
    mocks.resolveManagedAliDocMindCredentials.mockReset();
    mocks.resolvePDFApiKey.mockReset();
    mocks.resolvePDFBaseUrl.mockReset();
    mocks.validateUrlForSSRF.mockReset();
    mocks.validateUrlForSSRFWithPolicy.mockReset().mockResolvedValue(null);
    mocks.allowLocalNetworksEnabled.mockReset().mockReturnValue(false);
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'legacy' });
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_req, handler) => handler('user:internal-user', new Headers()));
    mocks.consumePdfProviderVerificationRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.verifyAliDocMindCredentials.mockReset().mockResolvedValue({ ok: true });

    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolvePDFApiKey.mockImplementation(
      (_providerId: string, clientApiKey?: string) => clientApiKey,
    );
    mocks.resolvePDFBaseUrl.mockImplementation(
      (_providerId: string, clientBaseUrl?: string) => clientBaseUrl,
    );
    mocks.validateUrlForSSRF.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a MinerU Cloud redirect after one request without reading its body', async () => {
    const text = vi.fn().mockResolvedValue('redirect response body');
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      text,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await postVerifyPdfProvider({
      providerId: 'mineru-cloud',
      apiKey: 'test-key',
      baseUrl: 'https://mineru.example.com',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toEqual({
      success: false,
      errorCode: 'REDIRECT_NOT_ALLOWED',
      error: 'Redirects are not allowed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mineru.example.com/extract-results/batch/test-connection',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(text).not.toHaveBeenCalled();
  });

  it('preserves MinerU Cloud success responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await postVerifyPdfProvider({
      providerId: 'mineru-cloud',
      apiKey: 'test-key',
      baseUrl: 'https://mineru.example.com/',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      success: true,
      message: 'Connection successful',
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mineru.example.com/extract-results/batch/test-connection',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it.each([401, 403])('preserves MinerU Cloud authentication handling for %i', async (status) => {
    const text = vi.fn().mockResolvedValue('invalid token');
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      statusText: 'Unauthorized',
      text,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await postVerifyPdfProvider({
      providerId: 'mineru-cloud',
      apiKey: 'bad-key',
      baseUrl: 'https://mineru.example.com',
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Authentication failed: invalid token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mineru.example.com/extract-results/batch/test-connection',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing self-hosted redirect rejection contract', async () => {
    const text = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 308,
      text,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await postVerifyPdfProvider({
      providerId: 'mineru',
      baseUrl: 'https://mineru-self-hosted.example.com',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toEqual({
      success: false,
      errorCode: 'REDIRECT_NOT_ALLOWED',
      error: 'Redirects are not allowed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mineru-self-hosted.example.com',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(text).not.toHaveBeenCalled();
  });

  it('runs only AliDocMind under OIDC with user rate limit, strict BYOK network policy, and no-store', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    const res = await postVerifyPdfProvider({
      providerId: 'alidocmind',
      accessKeyId: 'byok-id',
      accessKeySecret: 'byok-secret',
      baseUrl: 'https://docmind.example',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.consumePdfProviderVerificationRateLimit).toHaveBeenCalledWith(
      'user:internal-user',
    );
    expect(mocks.validateUrlForSSRFWithPolicy).toHaveBeenCalledWith('https://docmind.example/', {
      allowLocalNetworks: false,
    });
    expect(mocks.verifyAliDocMindCredentials).toHaveBeenCalledWith(
      {
        accessKeyId: 'byok-id',
        accessKeySecret: 'byok-secret',
        endpoint: 'docmind.example',
      },
      { allowLocalNetworks: false, allowCustomPort: false },
    );
  });

  it('uses only server credentials and operator network policy for managed AliDocMind', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveManagedAliDocMindCredentials.mockReturnValue({
      accessKeyId: 'server-id',
      accessKeySecret: 'server-secret',
      baseUrl: 'https://docmind.internal:8443',
    });
    mocks.allowLocalNetworksEnabled.mockReturnValue(true);

    const res = await postVerifyPdfProvider({
      providerId: 'alidocmind',
      accessKeyId: 'attacker-id',
      accessKeySecret: 'attacker-secret',
      baseUrl: 'https://attacker.example',
    });

    expect(res.status).toBe(200);
    expect(mocks.validateUrlForSSRFWithPolicy).toHaveBeenCalledWith(
      'https://docmind.internal:8443/',
      { allowLocalNetworks: true },
    );
    expect(mocks.verifyAliDocMindCredentials).toHaveBeenCalledWith(
      {
        accessKeyId: 'server-id',
        accessKeySecret: 'server-secret',
        endpoint: 'docmind.internal:8443',
      },
      { allowLocalNetworks: true, allowCustomPort: true },
    );
  });

  it('keeps unsupported PDF providers closed in OIDC', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    const res = await postVerifyPdfProvider({ providerId: 'mineru-cloud', apiKey: 'api-key' });
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.error).toMatch(/unavailable for this provider/i);
    expect(mocks.resolvePDFBaseUrl).not.toHaveBeenCalled();
    expect(mocks.verifyAliDocMindCredentials).not.toHaveBeenCalled();
  });

  it('normalizes AliDocMind provider errors and does not return upstream messages', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    mocks.verifyAliDocMindCredentials.mockResolvedValue({
      ok: false,
      error: 'SignatureDoesNotMatch: secret=upstream-sensitive-value',
    });
    const res = await postVerifyPdfProvider({
      providerId: 'alidocmind',
      accessKeyId: 'byok-id',
      accessKeySecret: 'byok-secret',
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe('AliDocMind rejected the credentials or the verification request');
    expect(JSON.stringify(json)).not.toContain('upstream-sensitive-value');
  });

  it('returns 429 with Retry-After when the per-user verification limit is reached', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    const RateLimitError = (await import('@/lib/server/user-api-rate-limit'))
      .UserApiRateLimitExceededError;
    mocks.consumePdfProviderVerificationRateLimit.mockRejectedValue(new RateLimitError(21));
    const res = await postVerifyPdfProvider({ providerId: 'alidocmind' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('21');
    expect(mocks.verifyAliDocMindCredentials).not.toHaveBeenCalled();
  });

  it('rejects legacy anonymous owner identities in the OIDC handler', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    mocks.withRequestOwnerId.mockImplementationOnce(async (_req, handler) =>
      handler('anon:legacy-user', new Headers()),
    );
    const res = await postVerifyPdfProvider({ providerId: 'alidocmind' });
    expect(res.status).toBe(401);
    expect(mocks.consumePdfProviderVerificationRateLimit).not.toHaveBeenCalled();
    expect(mocks.verifyAliDocMindCredentials).not.toHaveBeenCalled();
  });

  it('rejects BYOK private endpoints before credential verification', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    mocks.validateUrlForSSRFWithPolicy.mockResolvedValue('Local/private network is not allowed');
    const res = await postVerifyPdfProvider({
      providerId: 'alidocmind',
      accessKeyId: 'byok-id',
      accessKeySecret: 'byok-secret',
      baseUrl: 'https://127.0.0.1',
    });
    expect(res.status).toBe(403);
    expect(mocks.verifyAliDocMindCredentials).not.toHaveBeenCalled();
  });

  it('rejects oversized OIDC verification requests', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'oidc' });
    const res = await postVerifyPdfProvider(
      { providerId: 'alidocmind' },
      { 'Content-Length': String(16 * 1024 + 1) },
    );
    expect(res.status).toBe(413);
    expect(mocks.verifyAliDocMindCredentials).not.toHaveBeenCalled();
  });
});
