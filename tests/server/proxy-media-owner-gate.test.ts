import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Dispatcher } from 'undici';

// proxy-media owner-gate hardening (phase-5 handler-first pass, no middleware
// change). The proxy fetches arbitrary caller-supplied URLs, so under OIDC it
// must run behind the app session like every other action route. The REAL
// `withRequestOwnerId` boundary runs against a stubbed auth config/session
// layer; the SSRF layers are stubbed here (the rebinding suite covers them) so
// the gate itself — and the legacy proxy path — stay under test.

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn((_req: unknown, headers: Headers) => {
    headers.append('Set-Cookie', 'anon_owner=minted; Path=/');
    return 'anon:legacy';
  }),
  validateUrlForSSRF: vi.fn<(url: string) => Promise<string | null>>(),
  createValidatedDispatcher: vi.fn(),
  fetch: vi.fn(),
  rateLimitQuery: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/session', () => ({
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
  resolveApplicationSession: mocks.resolveApplicationSession,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
// The REAL rate-limit helper runs (so its legacy skip and its 60-req ceiling are
// under test); only the database seam is faked.
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));
vi.mock('@/lib/server/ssrf-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/ssrf-guard')>();
  return {
    ...actual,
    validateUrlForSSRF: mocks.validateUrlForSSRF,
    findUnsafeNetworkTargetError: () => null,
  };
});
vi.mock('@/lib/server/pinned-dispatcher', () => ({
  createValidatedDispatcher: mocks.createValidatedDispatcher,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const OIDC_CONFIG = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
};

function proxyRequest(origin?: string): NextRequest {
  return new NextRequest('https://openmaic.example.com/api/proxy-media', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ url: 'https://cdn.example.com/clip.mp4' }),
  });
}

function authenticatedSession(role: 'member' | 'viewer') {
  return {
    status: 'authenticated' as const,
    session: { userId: 'internal-42', sessionId: 'session-1', tenantId: 'default', role },
  };
}

async function importPost() {
  const { POST } = await import('@/app/api/proxy-media/route');
  return POST;
}

describe('proxy-media — owner boundary (real withRequestOwnerId, stubbed session layer)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
    mocks.validateUrlForSSRF.mockReset().mockResolvedValue(null);
    mocks.fetch.mockReset();
    const destroyed = vi.fn(async () => undefined);
    mocks.createValidatedDispatcher.mockReturnValue({
      destroy: destroyed,
    } as unknown as Dispatcher);
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
    );
    // Admit the request: the upsert returns the window start date.
    mocks.rateLimitQuery.mockReset().mockResolvedValue({ rows: [{ window_started_at: new Date() }] });
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({ pool: { query: mocks.rateLimitQuery } });
    vi.stubEnv('DATABASE_URL', 'postgres://rate-limit.test/openmaic');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('rejects an unauthenticated proxy fetch with 401 before any upstream request', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ success: false, errorCode: 'LOGIN_REQUIRED' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('blocks viewer-role proxy fetches with 403 even with a matching origin', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('viewer'));

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin member proxy fetch with 403 INVALID_ORIGIN (CSRF)', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(proxyRequest('https://evil.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_ORIGIN' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the session store is unavailable', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when auth configuration cannot be resolved', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('misconfigured issuer');
    });

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('proxies for an authenticated member and rides owner headers on the blob', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects caller-supplied private URLs under OIDC with the SSRF verdict', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));
    mocks.validateUrlForSSRF.mockResolvedValue('Local/private network URLs are not allowed');

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_URL' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('preserves legacy anonymous proxying and rides the minted owner cookie', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (await importPost())(proxyRequest());

    expect(res.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
    // Legacy owners are skipped by the helper before it touches the database.
    expect(mocks.getServerPersistenceProvider).not.toHaveBeenCalled();
  });

  it('consumes the proxy_media 60-req window before any upstream request', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));

    expect(res.status).toBe(200);
    expect(mocks.getServerPersistenceProvider).toHaveBeenCalledWith('postgres://rate-limit.test/openmaic');
    const [sql, params] = mocks.rateLimitQuery.mock.calls[0];
    expect(sql).toContain('user_api_rate_limits');
    expect(params[1]).toBe('proxy_media');
    // The media proxy's own ceiling, not the shared 5-req action budget.
    expect(params[2]).toBe(60);
    expect(mocks.rateLimitQuery.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fetch.mock.invocationCallOrder[0],
    );
  });

  it('answers 429 with Retry-After and never reaches upstream once the window is spent', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));
    mocks.rateLimitQuery
      .mockResolvedValueOnce({ rows: [] }) // upsert rejected: window spent
      .mockResolvedValueOnce({ rows: [{ retry_after: 23 }] }); // Retry-After read

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('23');
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the rate-limit store is unavailable', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));
    mocks.getServerPersistenceProvider.mockRejectedValue(new Error('pool unavailable'));

    const res = await (await importPost())(proxyRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
