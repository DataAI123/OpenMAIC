import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAuthConfig: vi.fn(),
  resolveApplicationSession: vi.fn(),
  clearedSessionCookieHeader: vi.fn(() => 'openmaic_session=; Max-Age=0'),
  resolveRequestOwnerId: vi.fn(() => 'anon:legacy'),
}));

vi.mock('@/lib/server/auth/config', () => ({
  resolveAuthConfig: mocks.resolveAuthConfig,
}));
vi.mock('@/lib/server/auth/session', () => ({
  clearedSessionCookieHeader: mocks.clearedSessionCookieHeader,
  resolveApplicationSession: mocks.resolveApplicationSession,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));

import {
  resolveRequestOwnerIdForRequest,
  withRequestOwnerId,
} from '@/lib/server/agent-runtime/with-owner';

const oidcConfig = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
  issuer: 'https://id.example.com/realms/openmaic',
  clientId: 'openmaic-web',
  clientSecret: 'secret',
  redirectUri: 'https://openmaic.example.com/api/auth/callback',
  sessionSigningKey: new Uint8Array(32),
  flowEncryptionKey: new Uint8Array(32),
  sessionTtlSeconds: 900,
  autoProvisionUsers: false,
  defaultTenant: 'default',
};

describe('request owner authentication boundary', () => {
  afterEach(() => vi.resetAllMocks());

  it('preserves the anonymous owner only in legacy mode', async () => {
    mocks.resolveAuthConfig.mockReturnValue({ mode: 'legacy' });
    mocks.resolveRequestOwnerId.mockReturnValue('anon:legacy');
    const result = await resolveRequestOwnerIdForRequest(
      new Request('https://openmaic.example.com/api/stages', { method: 'GET' }),
    );

    expect(result).toMatchObject({ ownerId: 'anon:legacy' });
    expect(mocks.resolveRequestOwnerId).toHaveBeenCalledOnce();
    expect(mocks.resolveApplicationSession).not.toHaveBeenCalled();
  });

  it('never mints an anonymous owner in OIDC mode', async () => {
    mocks.resolveAuthConfig.mockReturnValue(oidcConfig);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'missing' });

    // A missing session is refused, never downgraded to an anonymous owner.
    // The legacy anonymous-cookie primitive must not run under OIDC, so no old
    // `anon:` partition can be reached after the mode switch.
    await expect(
      resolveRequestOwnerIdForRequest(
        new Request('https://openmaic.example.com/api/stages', { method: 'GET' }),
      ),
    ).resolves.toMatchObject({ response: { status: 401 } });
    await expect(
      resolveRequestOwnerIdForRequest(
        new Request('https://openmaic.example.com/api/stages', {
          method: 'POST',
          headers: { origin: oidcConfig.appOrigin },
        }),
      ),
    ).resolves.toMatchObject({ response: { status: 401 } });

    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });

  it('answers tenant-required when a valid session has no chosen tenant', async () => {
    mocks.resolveAuthConfig.mockReturnValue(oidcConfig);
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'tenant-required',
      userId: 'internal-42',
      sessionId: 'session-1',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });

    const result = await resolveRequestOwnerIdForRequest(
      new Request('https://openmaic.example.com/api/stages', {
        method: 'POST',
        headers: { origin: oidcConfig.appOrigin },
      }),
    );
    expect(result).toMatchObject({ response: { status: 403 } });
    if (!('response' in result)) throw new Error('Expected a refusal response');
    expect(await result.response.json()).toEqual({
      success: false,
      errorCode: 'TENANT_REQUIRED',
      error: 'tenant_required',
    });
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });

  it('uses the internal user id and enforces viewer and same-origin write rules', async () => {
    mocks.resolveAuthConfig.mockReturnValue(oidcConfig);
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'authenticated',
      session: {
        userId: 'internal-42',
        sessionId: 'session-1',
        tenantId: 'default',
        role: 'member',
      },
    });
    const request = new Request('https://openmaic.example.com/api/stages', {
      method: 'POST',
      headers: { origin: oidcConfig.appOrigin },
    });

    await expect(resolveRequestOwnerIdForRequest(request)).resolves.toMatchObject({
      ownerId: 'user:internal-42',
    });

    const probeRequest = new Request('https://openmaic.example.com/api/provider/probe-models', {
      method: 'POST',
      headers: { origin: oidcConfig.appOrigin },
    });
    await expect(resolveRequestOwnerIdForRequest(probeRequest)).resolves.toMatchObject({
      ownerId: 'user:internal-42',
    });

    mocks.resolveApplicationSession.mockResolvedValueOnce({
      status: 'authenticated',
      session: { userId: 'viewer-1', sessionId: 'session-2', tenantId: 'default', role: 'viewer' },
    });
    await expect(resolveRequestOwnerIdForRequest(request)).resolves.toMatchObject({
      response: { status: 403 },
    });

    mocks.resolveApplicationSession.mockResolvedValueOnce({
      status: 'authenticated',
      session: { userId: 'viewer-1', sessionId: 'session-2', tenantId: 'default', role: 'viewer' },
    });
    await expect(resolveRequestOwnerIdForRequest(probeRequest)).resolves.toMatchObject({
      response: { status: 403 },
    });

    mocks.resolveApplicationSession.mockResolvedValueOnce({
      status: 'authenticated',
      session: { userId: 'viewer-1', sessionId: 'session-2', tenantId: 'default', role: 'viewer' },
    });
    await expect(
      resolveRequestOwnerIdForRequest(
        new Request('https://openmaic.example.com/api/server-providers', { method: 'GET' }),
      ),
    ).resolves.toMatchObject({ ownerId: 'user:viewer-1', tenantId: 'default' });

    mocks.resolveApplicationSession.mockResolvedValueOnce({
      status: 'authenticated',
      session: { userId: 'member-1', sessionId: 'session-3', tenantId: 'default', role: 'member' },
    });
    await expect(
      resolveRequestOwnerIdForRequest(
        new Request(request.url, { method: 'POST', headers: { origin: 'https://attacker.test' } }),
      ),
    ).resolves.toMatchObject({ response: { status: 403 } });
  });

  it('passes the trusted tenant identity into the owner-scoped handler', async () => {
    mocks.resolveAuthConfig.mockReturnValue(oidcConfig);
    mocks.resolveApplicationSession.mockResolvedValue({
      status: 'authenticated',
      session: {
        userId: 'internal-42',
        sessionId: 'session-1',
        tenantId: 'default',
        role: 'member',
      },
    });
    const request = new Request('https://openmaic.example.com/api/generate-classroom', {
      method: 'POST',
      headers: { origin: oidcConfig.appOrigin },
    });
    let receivedIdentity: unknown;

    const response = await withRequestOwnerId(request, async (ownerId, _headers, identity) => {
      receivedIdentity = identity;
      return new Response(ownerId);
    });

    expect(response.status).toBe(200);
    expect(receivedIdentity).toEqual({ ownerId: 'user:internal-42', tenantId: 'default' });
  });

  it('denies missing sessions except for explicitly opted-in public GETs', async () => {
    mocks.resolveAuthConfig.mockReturnValue(oidcConfig);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'missing' });
    const get = new Request('https://openmaic.example.com/api/stages/public-stage', {
      method: 'GET',
    });

    await expect(resolveRequestOwnerIdForRequest(get)).resolves.toMatchObject({
      response: { status: 401 },
    });
    await expect(
      resolveRequestOwnerIdForRequest(get, { allowAnonymousPublicRead: () => true }),
    ).resolves.toMatchObject({ ownerId: 'public:anonymous' });
    await expect(
      resolveRequestOwnerIdForRequest(new Request(get.url, { method: 'POST' }), {
        allowAnonymousPublicRead: () => true,
      }),
    ).resolves.toMatchObject({ response: { status: 401 } });
  });

  it('fails closed when configuration or session persistence is unavailable', async () => {
    mocks.resolveAuthConfig.mockImplementation(() => {
      throw new Error('invalid config');
    });
    await expect(
      resolveRequestOwnerIdForRequest(new Request('https://openmaic.example.com/api/stages')),
    ).resolves.toMatchObject({ response: { status: 503 } });

    mocks.resolveAuthConfig.mockReturnValue(oidcConfig);
    mocks.resolveApplicationSession.mockResolvedValue({ status: 'unavailable' });
    await expect(
      resolveRequestOwnerIdForRequest(new Request('https://openmaic.example.com/api/stages')),
    ).resolves.toMatchObject({ response: { status: 503 } });
  });
});
