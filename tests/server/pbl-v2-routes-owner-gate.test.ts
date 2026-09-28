import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// pbl/v2 owner-gate hardening (phase-5 handler-first pass, no middleware
// change). Real `withRequestOwnerId` boundary over a stubbed auth config/session
// layer for all five action routes: unauthenticated writes 401, viewer writes
// 403, cross-origin writes 403, auth failures 503, legacy replies ride the
// minted owner cookie — including the SSE responses.

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn((_req: unknown, headers: Headers) => {
    headers.append('Set-Cookie', 'anon_owner=minted; Path=/');
    return 'anon:legacy';
  }),
  createSSEResponse: vi.fn(() => new Response('sse-body')),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/session', () => ({
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
  resolveApplicationSession: mocks.resolveApplicationSession,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/pbl/v2/api/sse', () => ({ createSSEResponse: mocks.createSSEResponse }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: async () => ({
    model: {},
    modelInfo: { capabilities: {} },
    modelString: 'p:m',
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

const ROUTES = [
  ['evaluate', '@/app/api/pbl/v2/evaluate/route'],
  ['instructor', '@/app/api/pbl/v2/instructor/route'],
  ['open-task', '@/app/api/pbl/v2/open-task/route'],
  ['simulator', '@/app/api/pbl/v2/simulator/route'],
  ['task-update', '@/app/api/pbl/v2/task/update/route'],
] as const;

function pblRequest(body: Record<string, unknown>, origin?: string): NextRequest {
  return new NextRequest('https://openmaic.example.com/api/pbl/v2/any', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

function authenticatedSession(role: 'member' | 'viewer') {
  return {
    status: 'authenticated' as const,
    session: { userId: 'u1', sessionId: 's1', tenantId: 'default', role },
  };
}

describe('pbl/v2 — owner boundary wiring', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
    mocks.createSSEResponse.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const [name, module] of ROUTES) {
    it(`${name}: rejects an unauthenticated write with 401 LOGIN_REQUIRED before route logic`, async () => {
      mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
      mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

      const { POST } = await import(module);
      const res = await POST(pblRequest({}));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json).toMatchObject({ success: false, errorCode: 'LOGIN_REQUIRED' });
      expect(res.headers.get('set-cookie')).toContain('openmaic_session=');
      expect(mocks.createSSEResponse).not.toHaveBeenCalled();
    });

    it(`${name}: blocks viewer-role writes with 403 FORBIDDEN`, async () => {
      mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
      mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('viewer'));

      const { POST } = await import(module);
      const res = await POST(pblRequest({}, 'https://openmaic.example.com'));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ errorCode: 'FORBIDDEN' });
    });

    it(`${name}: rejects a cross-origin member write with 403 INVALID_ORIGIN (CSRF)`, async () => {
      mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
      mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

      const { POST } = await import(module);
      const res = await POST(pblRequest({}, 'https://evil.example.com'));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_ORIGIN' });
    });

    it(`${name}: fails closed with 503 when auth configuration cannot be resolved`, async () => {
      mocks.resolveAuthConfig.mockImplementation(() => {
        throw new Error('misconfigured issuer');
      });

      const { POST } = await import(module);
      const res = await POST(pblRequest({}));

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    });

    it(`${name}: keeps legacy flow and rides the minted owner cookie on the reply`, async () => {
      mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

      const { POST } = await import(module);
      // Missing `project` short-circuits to a 400 inside the handler; the point
      // is that owner response headers ride even that early reply.
      const res = await POST(pblRequest({}));

      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
    });
  }

  it('instructor: SSE success reply also carries the owner headers (legacy)', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const { POST } = await import('@/app/api/pbl/v2/instructor/route');
    const res = await POST(pblRequest({ project: {}, userMessage: 'hello' }));

    expect(res.status).toBe(200);
    expect(mocks.createSSEResponse).toHaveBeenCalledOnce();
    await expect(res.text()).resolves.toBe('sse-body');
    expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
  });
});
