import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// generate/agent-profiles owner-gate hardening (phase-5 handler-first pass, no
// middleware change). Real `withRequestOwnerId` boundary over a stubbed auth
// config/session layer: unauthenticated writes get 401, viewer writes 403,
// cross-origin writes 403, auth failures 503, and the LLM call runs under the
// server-derived usage attribution context.

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
  resolveModelFromRequest: async () => ({
    model: 'profile-model',
    modelString: 'profile-model',
    thinkingConfig: undefined,
  }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const OIDC_CONFIG = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
};

const TWO_AGENTS = JSON.stringify({
  agents: [
    { name: 'T', role: 'teacher', persona: 'p', avatar: 'a.svg', color: '#fff', priority: 10 },
    { name: 'S', role: 'student', persona: 'p', avatar: 'b.svg', color: '#000', priority: 5 },
  ],
});

function profilesRequest(origin?: string): NextRequest {
  return new NextRequest('https://openmaic.example.com/api/generate/agent-profiles', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({
      stageInfo: { name: 'Stage' },
      languageDirective: 'Use English',
      availableAvatars: ['a.svg', 'b.svg'],
    }),
  });
}

function authenticatedSession(role: 'member' | 'viewer') {
  return {
    status: 'authenticated' as const,
    session: { userId: 'internal-42', sessionId: 'session-1', tenantId: 'default', role },
  };
}

async function importPost() {
  const { POST } = await import('@/app/api/generate/agent-profiles/route');
  return POST;
}

describe('generate/agent-profiles — owner boundary (real withRequestOwnerId, stubbed session layer)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
    mocks.consumeActionRateLimit.mockClear();
    mocks.callLLM.mockReset();
    mocks.callLLM.mockResolvedValue({ text: TWO_AGENTS });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unauthenticated write with 401 LOGIN_REQUIRED before any LLM call', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

    const res = await (await importPost())(profilesRequest('https://openmaic.example.com'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ success: false, errorCode: 'LOGIN_REQUIRED' });
    expect(res.headers.get('set-cookie')).toContain('openmaic_session=');
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('blocks viewer-role writes with 403 even with a matching origin', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('viewer'));

    const res = await (await importPost())(profilesRequest('https://openmaic.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin member write with 403 INVALID_ORIGIN (CSRF)', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(profilesRequest('https://evil.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_ORIGIN' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the session store is unavailable', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });

    const res = await (await importPost())(profilesRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when auth configuration cannot be resolved', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('misconfigured issuer');
    });

    const res = await (await importPost())(profilesRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('generates under the server-derived usage attribution context when authenticated', async () => {
    const { currentUsageAttribution } = await import('@/lib/server/usage-attribution');
    const seen: Array<unknown> = [];
    mocks.callLLM.mockImplementation(async () => {
      seen.push(currentUsageAttribution());
      return { text: TWO_AGENTS };
    });
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(profilesRequest('https://openmaic.example.com'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.agents).toHaveLength(2);
    expect(seen).toEqual([{ ownerId: 'user:internal-42', tenantId: 'default' }]);
  });

  it('preserves legacy anonymous generation and rides the minted owner cookie on the reply', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (await importPost())(profilesRequest());

    expect(res.status).toBe(200);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
  });
});
