import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  withRequestOwnerId: vi.fn(),
  extractDocument: vi.fn(),
  loggerError: vi.fn(),
  consumeActionRateLimit: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', async () => {
  class UserApiRateLimitExceededError extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super('rate limited');
      this.name = 'UserApiRateLimitExceededError';
    }
  }
  return {
    UserApiRateLimitExceededError,
    consumeActionRateLimit: mocks.consumeActionRateLimit,
  };
});
vi.mock('@/lib/document', () => ({
  extractDocument: mocks.extractDocument,
  documentArtifactToParsedPdfContent: () => ({
    text: 'parsed text',
    images: [],
    metadata: { pageCount: 1 },
  }),
}));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => false,
  resolvePDFApiKey: (_providerId: string, clientKey?: string) => clientKey,
  resolvePDFBaseUrl: (_providerId: string, clientBaseUrl?: string) => clientBaseUrl,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: async () => null }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
    debug: vi.fn(),
  }),
}));

describe('POST /api/parse-pdf OIDC identity boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset().mockReturnValue({ mode: 'oidc' });
    mocks.withRequestOwnerId
      .mockReset()
      .mockImplementation(async (_request, handler) =>
        handler('user:alice', new Headers(), { ownerId: 'user:alice', tenantId: 'default' }),
      );
    mocks.extractDocument.mockReset().mockResolvedValue({
      text: 'parsed text',
      images: [],
      metadata: { pageCount: 1 },
    });
    mocks.loggerError.mockReset();
    mocks.consumeActionRateLimit.mockReset().mockResolvedValue(undefined);
  });

  function request() {
    const body = new FormData();
    body.append('pdf', new File(['pdf bytes'], 'private.pdf', { type: 'application/pdf' }));
    body.append('providerId', 'unpdf');
    return new Request('https://openmaic.example.com/api/parse-pdf', {
      method: 'POST',
      headers: { origin: 'https://openmaic.example.com' },
      body,
    });
  }

  it('requires the database-backed owner boundary and marks parsed content private', async () => {
    const req = request();
    const { POST } = await import('@/app/api/parse-pdf/route');
    const response = await POST(req as unknown as NextRequest);

    expect(mocks.withRequestOwnerId).toHaveBeenCalledWith(req, expect.any(Function));
    expect(mocks.extractDocument).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({ success: true });
  });

  it('sanitizes provider errors and logs no filename or provider detail in OIDC mode', async () => {
    mocks.extractDocument.mockRejectedValue(new Error('secret endpoint and provider response'));
    const { POST } = await import('@/app/api/parse-pdf/route');
    const response = await POST(request() as unknown as NextRequest);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('The PDF could not be parsed. Please try again later.');
    expect(JSON.stringify(body)).not.toContain('secret endpoint');
    expect(mocks.loggerError).toHaveBeenCalledWith('PDF parsing failed for an OIDC request');
  });

  it('does not invoke parsing when the owner boundary rejects the request', async () => {
    mocks.withRequestOwnerId.mockResolvedValue(
      Response.json({ success: false, errorCode: 'LOGIN_REQUIRED' }, { status: 401 }),
    );
    const { POST } = await import('@/app/api/parse-pdf/route');

    await expect(POST(request() as unknown as NextRequest)).resolves.toHaveProperty('status', 401);
    expect(mocks.extractDocument).not.toHaveBeenCalled();
  });

  it('preserves legacy raw error responses and does not add an OIDC owner dependency', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    mocks.extractDocument.mockRejectedValue(new Error('legacy parser detail'));
    const { POST } = await import('@/app/api/parse-pdf/route');
    const response = await POST(request() as unknown as NextRequest);
    const body = await response.json();

    expect(mocks.withRequestOwnerId).not.toHaveBeenCalled();
    expect(body.error).toBe('legacy parser detail');
  });

  it('consumes the parse_pdf per-user window before any provider call', async () => {
    const { POST } = await import('@/app/api/parse-pdf/route');
    const response = await POST(request() as unknown as NextRequest);

    expect(response.status).toBe(200);
    expect(mocks.consumeActionRateLimit).toHaveBeenCalledWith('user:alice', 'parse_pdf');
    expect(mocks.consumeActionRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.extractDocument.mock.invocationCallOrder[0],
    );
  });

  it('answers 429 with Retry-After and never parses once the window is exhausted', async () => {
    const { UserApiRateLimitExceededError } = await import('@/lib/server/user-api-rate-limit');
    mocks.consumeActionRateLimit.mockRejectedValue(new UserApiRateLimitExceededError(37));
    const { POST } = await import('@/app/api/parse-pdf/route');
    const response = await POST(request() as unknown as NextRequest);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('37');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.extractDocument).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the rate-limit store is unavailable', async () => {
    mocks.consumeActionRateLimit.mockRejectedValue(
      new Error('USER_API_RATE_LIMIT_DATABASE_UNAVAILABLE'),
    );
    const { POST } = await import('@/app/api/parse-pdf/route');
    const response = await POST(request() as unknown as NextRequest);

    expect(response.status).toBe(503);
    expect(mocks.extractDocument).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared multipart body before buffering it', async () => {
    const { POST } = await import('@/app/api/parse-pdf/route');
    const oversized = {
      method: 'POST',
      url: 'https://openmaic.example.com/api/parse-pdf',
      headers: new Headers({
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(512 * 1024 * 1024),
      }),
    } as unknown as NextRequest;
    const response = await POST(oversized);

    expect(response.status).toBe(413);
    expect(mocks.extractDocument).not.toHaveBeenCalled();
  });

  it('rejects a PDF file above the extraction size cap', async () => {
    const body = new FormData();
    body.append(
      'pdf',
      new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'huge.pdf', { type: 'application/pdf' }),
    );
    body.append('providerId', 'unpdf');
    const req = new Request('https://openmaic.example.com/api/parse-pdf', {
      method: 'POST',
      headers: { origin: 'https://openmaic.example.com' },
      body,
    });
    const { POST } = await import('@/app/api/parse-pdf/route');
    const response = await POST(req as unknown as NextRequest);

    expect(response.status).toBe(413);
    expect(mocks.extractDocument).not.toHaveBeenCalled();
  });
});
