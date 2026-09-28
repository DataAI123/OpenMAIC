import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// generate/scene-{content,actions,outlines-stream} owner-gate hardening
// (phase-5 handler-first pass, no middleware change). Real `withRequestOwnerId`
// boundary over a stubbed auth config/session layer: unauthenticated writes are
// rejected before any LLM call, and legacy replies ride the minted owner cookie.

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn((_req: unknown, headers: Headers) => {
    headers.append('Set-Cookie', 'anon_owner=minted; Path=/');
    return 'anon:legacy';
  }),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/session', () => ({
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
  resolveApplicationSession: mocks.resolveApplicationSession,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/ai/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/llm')>();
  return { ...actual, callLLM: mocks.callLLM };
});
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: async () => ({
    model: {},
    modelInfo: { providerId: 'p', modelId: 'm' },
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
  ['content', '@/app/api/generate/scene-content/route'],
  ['actions', '@/app/api/generate/scene-actions/route'],
  ['outlines-stream', '@/app/api/generate/scene-outlines-stream/route'],
] as const;

function postJson(path: string, body: Record<string, unknown>, origin?: string): NextRequest {
  return new NextRequest(`https://openmaic.example.com/api/generate/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('generate/scene-* — owner boundary wiring', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
    mocks.callLLM.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const [name, module] of ROUTES) {
    it(`${name}: rejects an unauthenticated write with 401 LOGIN_REQUIRED before any LLM call`, async () => {
      mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
      mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

      const { POST } = await import(module);
      const res = await POST(postJson(name, {}));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json).toMatchObject({ success: false, errorCode: 'LOGIN_REQUIRED' });
      expect(res.headers.get('set-cookie')).toContain('openmaic_session=');
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it(`${name}: rejects a cross-origin member write with 403 INVALID_ORIGIN (CSRF)`, async () => {
      mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
      mocks.resolveApplicationSession.mockResolvedValue({
        status: 'authenticated',
        session: { userId: 'u1', sessionId: 's1', tenantId: 'default', role: 'member' },
      });

      const { POST } = await import(module);
      const res = await POST(postJson(name, {}, 'https://evil.example.com'));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_ORIGIN' });
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it(`${name}: fails closed with 503 when auth configuration cannot be resolved`, async () => {
      mocks.resolveAuthConfig.mockImplementation(() => {
        throw new Error('misconfigured issuer');
      });

      const { POST } = await import(module);
      const res = await POST(postJson(name, {}));

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    });

    it(`${name}: keeps legacy flow and rides the minted owner cookie on the reply`, async () => {
      mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

      const { POST } = await import(module);
      // An intentionally invalid body short-circuits to a 400 from inside the
      // handler; the point is that the owner headers still ride the reply.
      const res = await POST(postJson(name, {}));

      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
    });
  }
});
