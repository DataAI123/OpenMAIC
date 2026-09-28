import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// quiz-grade owner-gate hardening (phase-5 handler-first pass, no middleware
// change). Same posture as the generate/voice gate test: the REAL
// `withRequestOwnerId` boundary runs against a stubbed auth config/session layer,
// locking login-required / viewer-write / CSRF-origin / fail-closed behavior and
// proving the LLM call happens under server-derived usage attribution.

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn((_req: unknown, headers: Headers) => {
    headers.append('Set-Cookie', 'anon_owner=minted; Path=/');
    return 'anon:legacy';
  }),
  callLLM: vi.fn(),
  consumeActionRateLimit: vi.fn(async (_ownerId: string, _routeKey: string) => undefined),
  UserApiRateLimitExceededError: class UserApiRateLimitExceededError extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super('User API rate limit exceeded');
    }
  },
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/session', () => ({
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
  resolveApplicationSession: mocks.resolveApplicationSession,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeActionRateLimit: mocks.consumeActionRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: async () => ({ model: 'grade-model', thinkingConfig: undefined }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const OIDC_CONFIG = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
};

function gradeRequest(origin?: string): NextRequest {
  return new NextRequest('https://openmaic.example.com/api/quiz-grade', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ question: 'Q?', userAnswer: 'A.', points: 10 }),
  });
}

function authenticatedSession(role: 'member' | 'viewer') {
  return {
    status: 'authenticated' as const,
    session: { userId: 'internal-42', sessionId: 'session-1', tenantId: 'default', role },
  };
}

async function importPost() {
  const { POST } = await import('@/app/api/quiz-grade/route');
  return POST;
}

describe('quiz-grade — owner boundary (real withRequestOwnerId, stubbed session layer)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
    mocks.consumeActionRateLimit.mockClear();
    mocks.callLLM.mockReset();
    mocks.callLLM.mockResolvedValue({ text: '{"score": 8, "comment": "good"}' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unauthenticated write with 401 LOGIN_REQUIRED before any LLM call', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

    const res = await (await importPost())(gradeRequest('https://openmaic.example.com'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ success: false, errorCode: 'LOGIN_REQUIRED' });
    expect(res.headers.get('set-cookie')).toContain('openmaic_session=');
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('blocks viewer-role writes with 403 even with a matching origin', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('viewer'));

    const res = await (await importPost())(gradeRequest('https://openmaic.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin member write with 403 INVALID_ORIGIN (CSRF)', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(gradeRequest('https://evil.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_ORIGIN' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the session store is unavailable', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });

    const res = await (await importPost())(gradeRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when auth configuration cannot be resolved', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('misconfigured issuer');
    });

    const res = await (await importPost())(gradeRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('grades under the server-derived usage attribution context when authenticated', async () => {
    const { currentUsageAttribution } = await import('@/lib/server/usage-attribution');
    const seen: Array<unknown> = [];
    mocks.callLLM.mockImplementation(async () => {
      seen.push(currentUsageAttribution());
      return { text: '{"score": 8, "comment": "good"}' };
    });
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(gradeRequest('https://openmaic.example.com'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, score: 8 });
    expect(seen).toEqual([{ ownerId: 'user:internal-42', tenantId: 'default' }]);
    expect(mocks.consumeActionRateLimit).toHaveBeenCalledWith('user:internal-42', 'quiz_grade');
  });

  it('returns 429 with Retry-After when the per-user action window is exhausted', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));
    mocks.consumeActionRateLimit.mockRejectedValueOnce(new mocks.UserApiRateLimitExceededError(23));

    const res = await (await importPost())(gradeRequest('https://openmaic.example.com'));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('23');
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the rate-limit store is unavailable', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));
    mocks.consumeActionRateLimit.mockRejectedValueOnce(
      new Error('USER_API_RATE_LIMIT_DATABASE_UNAVAILABLE'),
    );

    const res = await (await importPost())(gradeRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('preserves legacy anonymous grading and rides the minted owner cookie on the reply', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (await importPost())(gradeRequest());

    expect(res.status).toBe(200);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
  });
});
