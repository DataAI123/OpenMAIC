import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// generate/voice owner-gate hardening (phase-5 handler-first pass, no middleware
// change). The route now runs inside the REAL `withRequestOwnerId` boundary with
// only the auth config/session layer stubbed, locking: unauthenticated writes get
// 401, viewer writes get 403, cross-origin writes get 403, auth failures get 503,
// authenticated provider calls carry server-derived usage attribution, and every
// reply rides the owner response headers.

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn((_req: unknown, headers: Headers) => {
    headers.append('Set-Cookie', 'anon_owner=minted; Path=/');
    return 'anon:legacy';
  }),
  adapter: {
    deleteVoice: vi.fn(),
    voiceExists: vi.fn(),
    registerVoice: vi.fn(),
    bootstrapReferenceClip: vi.fn(),
  },
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
vi.mock('@/lib/server/user-api-rate-limit', () => ({
  consumeActionRateLimit: mocks.consumeActionRateLimit,
  UserApiRateLimitExceededError: mocks.UserApiRateLimitExceededError,
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    isServerConfiguredProvider: () => false,
    isServerTTSProviderDisabled: () => false,
    resolveTTSApiKey: (_id: string, clientKey?: string) => clientKey,
    resolveTTSBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
    resolveTTSModel: (_id: string, clientModel?: string) => clientModel || 'voice-model',
    resolveQwenVoiceCloneModel: () => 'qwen-voice-model',
  };
});

vi.mock('@/lib/audio/voice-registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/voice-registration')>();
  return { ...actual, getVoiceRegistrationAdapter: () => mocks.adapter };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const OIDC_CONFIG = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
};

const PUBLIC_BASE_URL = 'http://8.8.8.8/v1/';

function voiceRequest(origin?: string): NextRequest {
  return new NextRequest('https://openmaic.example.com/api/generate/voice', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({
      providerId: 'qwen-tts',
      voiceId: 'voice-1',
      action: 'delete',
      ttsApiKey: 'client-key',
      ttsBaseUrl: PUBLIC_BASE_URL,
    }),
  });
}

function authenticatedSession(role: 'member' | 'viewer') {
  return {
    status: 'authenticated' as const,
    session: {
      userId: 'internal-42',
      sessionId: 'session-1',
      tenantId: 'default',
      role,
    },
  };
}

async function importPost() {
  const { POST } = await import('@/app/api/generate/voice/route');
  return POST;
}

describe('generate/voice — owner boundary (real withRequestOwnerId, stubbed session layer)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', undefined);
    vi.resetModules();
    mocks.resolveAuthConfig.mockReset();
    mocks.resolveApplicationSession.mockReset();
    mocks.clearedSessionCookieHeader.mockReset().mockReturnValue('openmaic_session=; Max-Age=0');
    mocks.resolveRequestOwnerId.mockClear();
    mocks.consumeActionRateLimit.mockClear();
    mocks.adapter.deleteVoice.mockReset();
    mocks.adapter.deleteVoice.mockResolvedValue(undefined);
    mocks.adapter.voiceExists.mockReset();
    mocks.adapter.registerVoice.mockReset();
    mocks.adapter.bootstrapReferenceClip.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unauthenticated write with 401 LOGIN_REQUIRED before any provider call', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'invalid' });

    const res = await (await importPost())(voiceRequest('https://openmaic.example.com'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ success: false, errorCode: 'LOGIN_REQUIRED' });
    expect(res.headers.get('set-cookie')).toContain('openmaic_session=');
    expect(mocks.adapter.deleteVoice).not.toHaveBeenCalled();
  });

  it('blocks viewer-role writes with 403 even with a valid session and matching origin', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('viewer'));

    const res = await (await importPost())(voiceRequest('https://openmaic.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(mocks.adapter.deleteVoice).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin member write with 403 INVALID_ORIGIN (CSRF)', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(voiceRequest('https://evil.example.com'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'INVALID_ORIGIN' });
    expect(mocks.adapter.deleteVoice).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the session store is unavailable', async () => {
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });

    const res = await (await importPost())(voiceRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.adapter.deleteVoice).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when auth configuration cannot be resolved', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('misconfigured issuer');
    });

    const res = await (await importPost())(voiceRequest('https://openmaic.example.com'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: 'AUTH_UNAVAILABLE' });
    expect(mocks.adapter.deleteVoice).not.toHaveBeenCalled();
  });

  it('runs an authenticated write under the server-derived usage attribution context', async () => {
    const { currentUsageAttribution } = await import('@/lib/server/usage-attribution');
    const seen: Array<unknown> = [];
    mocks.adapter.deleteVoice.mockImplementation(async () => {
      seen.push(currentUsageAttribution());
    });
    mocks.resolveAuthConfig.mockReturnValue(OIDC_CONFIG);
    mocks.resolveApplicationSession.mockResolvedValue(authenticatedSession('member'));

    const res = await (await importPost())(voiceRequest('https://openmaic.example.com'));

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ ownerId: 'user:internal-42', tenantId: 'default' }]);
  });

  it('preserves legacy anonymous access and rides the minted owner cookie on the reply', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });

    const res = await (await importPost())(voiceRequest());

    expect(res.status).toBe(200);
    expect(mocks.adapter.deleteVoice).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('anon_owner=minted');
  });
});
