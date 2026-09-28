import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

const oldKey = new Uint8Array(32).fill(0x31);
const newKey = new Uint8Array(32).fill(0x62);
const issuedAt = Math.floor(Date.now() / 1000);
const oldConfig = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
  issuer: 'https://id.example.com/realms/openmaic',
  clientId: 'openmaic-web',
  clientSecret: 'secret',
  redirectUri: 'https://openmaic.example.com/api/auth/callback',
  sessionSigningKey: oldKey,
  flowEncryptionKey: new Uint8Array(32).fill(0x21),
  sessionTtlSeconds: 900,
  autoProvisionUsers: false,
  defaultTenant: 'default',
};

describe('session signing key rotation behavior', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    mocks.query.mockReset().mockResolvedValue({
      rows: [
        {
          user_id: 'internal-user',
          issuer: oldConfig.issuer,
          expires_at: new Date((issuedAt + oldConfig.sessionTtlSeconds) * 1000),
          revoked_at: null,
          user_status: 'active',
          active_tenant_id: 'default',
          tenant_id: 'default',
          tenant_status: 'active',
          role: 'owner',
        },
      ],
    });
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({
      pool: { query: mocks.query },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('invalidates existing sessions on rotation and accepts a newly signed session', async () => {
    const { resolveApplicationSession, signApplicationSession } =
      await import('@/lib/server/auth/session');
    const oldToken = await signApplicationSession(
      { userId: 'internal-user', sessionId: 'session-1', issuedAt },
      oldConfig,
    );
    const headers = new Headers({ cookie: `openmaic_session=${oldToken}` });
    const rotatedConfig = { ...oldConfig, sessionSigningKey: newKey };

    await expect(resolveApplicationSession(headers, rotatedConfig)).resolves.toEqual({
      status: 'invalid',
    });
    expect(mocks.getServerPersistenceProvider).not.toHaveBeenCalled();

    const newToken = await signApplicationSession(
      { userId: 'internal-user', sessionId: 'session-1', issuedAt },
      rotatedConfig,
    );
    await expect(
      resolveApplicationSession(
        new Headers({ cookie: `openmaic_session=${newToken}` }),
        rotatedConfig,
      ),
    ).resolves.toMatchObject({
      status: 'authenticated',
      session: { userId: 'internal-user', sessionId: 'session-1', role: 'owner' },
    });
    expect(mocks.getServerPersistenceProvider).toHaveBeenCalledOnce();
  });
});
