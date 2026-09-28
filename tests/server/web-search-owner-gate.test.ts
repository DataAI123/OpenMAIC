import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// web-search owner-gate hardening (phase-5 handler-first pass, no middleware
// change). Same posture as the quiz-grade gate test: the REAL
// `withRequestOwnerId` boundary runs against a stubbed auth config/session
// layer, locking login-required / viewer-write / CSRF-origin / fail-closed
// behavior and proving the search runs under server-derived usage attribution.

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn((_req: unknown, headers: Headers) => {
    headers.append('Set-Cookie', 'anon_owner=minted; Path=/');
    return 'anon:legacy';
  }),
  searchWeb: vi.fn(),
  callLLM: vi.fn(),
  consumeActionRateLimit: vi.fn(async (_ownerId: string, _routeKey: string) => undefined),
  UserApiRateLimitExceededError: class UserApiRateLimitExceededError extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super('User API rate limit exceeded');
    }
  },
  resolveModelFromRequest: vi.fn(async () => {
    throw new Error('no rewrite model in this test');
  }),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/session', () => ({
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
  resolveApplicationSession: mocks.resolveApplicationSession,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeActionRateLimit: mocks.consumeActionRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/web-search', () => ({
  searchWeb: mocks.searchWeb,
  formatSearchResultsAsContext: () => 'formatted context',
}));
vi.mock('@/lib/web-search/constants', () => ({
  WEB_SEARCH_PROVIDERS: {
    tavily: { id: 'tavily', name: 'Tavily', requiresApiKey: true, requiresBaseUrl: false },
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const OIDC_CONFIG = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
};

function searchRequest(origin?: string): NextRequest {
  return new NextRequest('https://openmaic.example.com/api/web-search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ query: 'fraction teaching resources', apiKey: 'client-key' }),
  });
}

function authenticatedSession(role: 'member' | 'viewer') {
  return {
    status: 'authenticated' as const,
    session: { userId: 'internal-42', sessionId: 'session-1', tenantId: 'default', role },
  };
}

const SEARCH_RESULT = {
  answer: 'an answer',
  sources: [{ title: 'Source', url: 'https://example.com' }],
  query: 'fraction teaching resources',
  responseTime: 12,
};

async function importPost() {
  const { POST } = await import('@/app/api/web-search/route');
  return POST;
}

describe('web-search — owner boundary (real withRequestOwnerId, stubbed session layer)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
    mocks.consumeActionRateLimit.mockReset();
    mocks.consumeActionRateLimit.mockResolvedValue(undefined);
    mocks.searchWeb.mockReset();
    mocks.searchWeb.mockResolvedValue(SEARCH_RESULT);
    mocks.callLLM.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unauthenticated search with 401 LOGIN_REQUIRED before any provider call', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

    const res = await (await importPost())(searchRequest('https://openmaic.example.com'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ success: false, errorCode: 'LOGIN_REQUIRED' });
    expect(res.headers.get('set-cookie')).toContain('openmaic_session=');
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('blocks viewer-role searches with 403 even with a matching origin', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('viewer'));

    const res = await (await importPost())(searchRequest('https://openmaic.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin member search with 403 INVALID_ORIGIN (CSRF)', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(searchRequest('https://evil.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_ORIGIN' });
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the session store is unavailable', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });

    const res = await (await importPost())(searchRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when auth configuration cannot be resolved', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('misconfigured issuer');
    });

    const res = await (await importPost())(searchRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('searches under the server-derived usage attribution context when authenticated', async () => {
    const { currentUsageAttribution } = await import('@/lib/server/usage-attribution');
    const seen: Array<unknown> = [];
    mocks.searchWeb.mockImplementation(async () => {
      seen.push(currentUsageAttribution());
      return SEARCH_RESULT;
    });
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(searchRequest('https://openmaic.example.com'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, answer: 'an answer' });
    expect(seen).toEqual([{ ownerId: 'user:internal-42', tenantId: 'default' }]);
    expect(mocks.consumeActionRateLimit).toHaveBeenCalledWith('user:internal-42', 'web_search');
  });

  it('returns 429 with Retry-After when the per-user web_search window is exhausted', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));
    mocks.consumeActionRateLimit.mockRejectedValueOnce(new mocks.UserApiRateLimitExceededError(23));

    const res = await (await importPost())(searchRequest('https://openmaic.example.com'));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('23');
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the rate-limit store is unavailable', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));
    mocks.consumeActionRateLimit.mockRejectedValueOnce(
      new Error('USER_API_RATE_LIMIT_DATABASE_UNAVAILABLE'),
    );

    const res = await (await importPost())(searchRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('preserves legacy anonymous searching and rides the minted owner cookie on the reply', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (await importPost())(searchRequest());

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
  });
});
