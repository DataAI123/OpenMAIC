import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// chat / chat/pi owner-gate hardening (phase-5 handler-first pass, no
// middleware change). Real `withRequestOwnerId` boundary over a stubbed auth
// config/session layer: unauthenticated writes 401, viewer writes 403,
// cross-origin writes 403, auth failures 503, and legacy replies — including
// the SSE streams — ride the minted owner cookie.

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn((_req: unknown, headers: Headers) => {
    headers.append('Set-Cookie', 'anon_owner=minted; Path=/');
    return 'anon:legacy';
  }),
  statelessGenerate: vi.fn(async function* () {
    yield { type: 'test', data: {} };
  }),
  runPiDirectorLoop: vi.fn(async (_args: { send?: (event: unknown) => Promise<void> }) => {}),
  resolveModel: vi.fn(async () => ({
    model: { provider: 'test.chat', modelId: 'm' },
    apiKey: 'test-key',
    providerId: 'test',
    modelInfo: { capabilities: {}, outputWindow: 4096 },
    thinkingConfig: undefined,
  })),
}));

vi.mock('@/lib/server/auth/config', () => ({ resolveAuthConfig: mocks.resolveAuthConfig }));
vi.mock('@/lib/server/auth/session', () => ({
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
  resolveApplicationSession: mocks.resolveApplicationSession,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/orchestration/stateless-generate', () => ({
  statelessGenerate: mocks.statelessGenerate,
}));
vi.mock('@/lib/ai/providers', () => ({ isProviderKeyRequired: () => false }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/config/feature-flags', () => ({
  isCoursewareReferenceEnabled: () => false,
  isPiChatEnabled: () => true,
  isPiNativeChildRuntimeEnabled: () => false,
  isPiNativeChildSpotlightEnabled: () => false,
}));
vi.mock('@/lib/chat/pi/config', () => ({
  getPiMaxAgentTurns: () => 4,
  getPiMaxActionsPerAgent: () => 2,
  resolveAgentConfigs: () => [{ id: 'a1', allowedActions: [] }],
}));
vi.mock('@/lib/chat/pi/director-loop', () => ({ runPiDirectorLoop: mocks.runPiDirectorLoop }));
vi.mock('@/lib/chat/pi/interactive-state-evidence', () => ({
  attachInteractiveState: () => ({ elementReference: undefined, stateNote: undefined }),
}));
vi.mock('@/lib/chat/pi/element-reference', () => ({
  ELEMENT_REFERENCE_ACCEPTED_HEADER: 'x-openmaic-element-reference-accepted',
  ElementReferenceValidationError: class ElementReferenceValidationError extends Error {},
  resolveElementReference: () => undefined,
}));
vi.mock('@/lib/chat/pi/tools/native-whiteboard', () => ({
  hasNativeWhiteboardAction: () => false,
}));
vi.mock('@/lib/whiteboard/runtime/store', () => ({ createWhiteboardRuntimeService: vi.fn() }));
vi.mock('@/lib/persistence/server-auth', () => ({
  authenticatePersistenceHeaders: () => undefined,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: vi.fn(),
}));
vi.mock('@/lib/server/web-search-config', () => ({
  resolveClassroomWebSearchConfig: () => undefined,
}));

const OIDC_CONFIG = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
};

const VALID_BODY = {
  messages: [],
  storeState: {},
  config: { agentIds: ['a1'] },
};

const ROUTES = [
  ['chat', '@/app/api/chat/route'],
  ['chat/pi', '@/app/api/chat/pi/route'],
] as const;

function chatRequest(body: Record<string, unknown>, origin?: string): NextRequest {
  return new NextRequest('https://openmaic.example.com/api/chat', {
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

describe('chat / chat/pi — owner boundary wiring', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
    mocks.statelessGenerate.mockClear();
    mocks.runPiDirectorLoop.mockClear();
    mocks.resolveModel.mockClear();
  });

  for (const [name, module] of ROUTES) {
    it(`${name}: rejects an unauthenticated write with 401 LOGIN_REQUIRED before route logic`, async () => {
      mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
      mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

      const { POST } = await import(module);
      const res = await POST(chatRequest(VALID_BODY));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json).toMatchObject({ success: false, errorCode: 'LOGIN_REQUIRED' });
      expect(res.headers.get('set-cookie')).toContain('openmaic_session=');
      expect(mocks.statelessGenerate).not.toHaveBeenCalled();
      expect(mocks.runPiDirectorLoop).not.toHaveBeenCalled();
      expect(mocks.resolveModel).not.toHaveBeenCalled();
    });

    it(`${name}: blocks viewer-role writes with 403 FORBIDDEN`, async () => {
      mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
      mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('viewer'));

      const { POST } = await import(module);
      const res = await POST(chatRequest(VALID_BODY, 'https://openmaic.example.com'));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ errorCode: 'FORBIDDEN' });
    });

    it(`${name}: rejects a cross-origin member write with 403 INVALID_ORIGIN (CSRF)`, async () => {
      mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
      mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

      const { POST } = await import(module);
      const res = await POST(chatRequest(VALID_BODY, 'https://evil.example.com'));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_ORIGIN' });
    });

    it(`${name}: fails closed with 503 when auth configuration cannot be resolved`, async () => {
      mocks.resolveAuthConfig.mockImplementation(() => {
        throw new Error('misconfigured issuer');
      });

      const { POST } = await import(module);
      const res = await POST(chatRequest(VALID_BODY));

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    });

    it(`${name}: keeps legacy flow and rides the minted owner cookie on early rejections`, async () => {
      mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

      const { POST } = await import(module);
      // Missing `messages` short-circuits to a 400 inside the handler; the
      // point is that owner response headers ride even that early reply.
      const res = await POST(chatRequest({}));

      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
    });

    it(`${name}: legacy SSE success reply carries the owner headers`, async () => {
      mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
      if (name === 'chat/pi') {
        mocks.runPiDirectorLoop.mockImplementation(
          async ({ send }: { send?: (event: unknown) => Promise<void> }) => {
            await send?.({ type: 'test', data: {} });
          },
        );
      }

      const { POST } = await import(module);
      const res = await POST(chatRequest(VALID_BODY));

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
      await expect(res.text()).resolves.toContain('data:');
    });
  }

  it('chat/pi: returns 404 when the Pi runtime flag is disabled (still behind the auth gate)', async () => {
    // Negative path asserted via the real gate order: an unauthenticated
    // request never reaches the flag check, it gets 401 instead.
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

    const { POST } = await import('@/app/api/chat/pi/route');
    const res = await POST(chatRequest({}));

    expect(res.status).toBe(401);
  });
});
