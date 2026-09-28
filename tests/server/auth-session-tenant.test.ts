import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

const key = new Uint8Array(32).fill(0x31);
const issuedAt = Math.floor(Date.now() / 1000);
const config = {
  mode: 'oidc' as const,
  appOrigin: 'https://openmaic.example.com',
  issuer: 'https://id.example.com/realms/openmaic',
  clientId: 'openmaic-web',
  clientSecret: 'secret',
  redirectUri: 'https://openmaic.example.com/api/auth/callback',
  sessionSigningKey: key,
  flowEncryptionKey: new Uint8Array(32).fill(0x21),
  sessionTtlSeconds: 900,
  autoProvisionUsers: false,
  defaultTenant: 'default',
};

function sessionRow(overrides: Record<string, unknown>) {
  return {
    user_id: 'internal-user',
    issuer: config.issuer,
    expires_at: new Date((issuedAt + config.sessionTtlSeconds) * 1000),
    revoked_at: null,
    user_status: 'active',
    active_tenant_id: 'default',
    tenant_id: 'default',
    tenant_status: 'active',
    role: 'owner',
    ...overrides,
  };
}

async function resolve() {
  const { resolveApplicationSession, signApplicationSession } =
    await import('@/lib/server/auth/session');
  const token = await signApplicationSession(
    { userId: 'internal-user', sessionId: 'session-1', issuedAt },
    config,
  );
  return resolveApplicationSession(new Headers({ cookie: `openmaic_session=${token}` }), config);
}

describe('session tenant resolution', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    mocks.query.mockReset();
    mocks.getServerPersistenceProvider.mockReset().mockResolvedValue({
      pool: { query: mocks.query },
    });
  });

  it('asks for a tenant when the session has not chosen one', async () => {
    mocks.query.mockResolvedValue({ rows: [sessionRow({ active_tenant_id: null })] });
    await expect(resolve()).resolves.toEqual({
      status: 'tenant-required',
      userId: 'internal-user',
      sessionId: 'session-1',
      expiresAt: issuedAt + config.sessionTtlSeconds,
    });
  });

  it('treats a chosen tenant with no active membership as invalid', async () => {
    mocks.query.mockResolvedValue({
      rows: [sessionRow({ active_tenant_id: 'default', tenant_id: null, tenant_status: null })],
    });
    await expect(resolve()).resolves.toEqual({ status: 'invalid' });
  });

  it('treats a chosen tenant that was suspended as invalid', async () => {
    mocks.query.mockResolvedValue({
      rows: [sessionRow({ active_tenant_id: 'default', tenant_status: 'suspended' })],
    });
    await expect(resolve()).resolves.toEqual({ status: 'invalid' });
  });

  it('authenticates against the session active tenant', async () => {
    mocks.query.mockResolvedValue({
      rows: [sessionRow({ active_tenant_id: 'second', tenant_id: 'second' })],
    });
    await expect(resolve()).resolves.toMatchObject({
      status: 'authenticated',
      session: { userId: 'internal-user', tenantId: 'second', role: 'owner' },
    });
  });

  it('does not ask for a tenant when the store is unavailable', async () => {
    mocks.getServerPersistenceProvider.mockRejectedValue(new Error('down'));
    await expect(resolve()).resolves.toEqual({ status: 'unavailable' });
  });
});
