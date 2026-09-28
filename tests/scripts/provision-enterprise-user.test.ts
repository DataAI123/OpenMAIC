import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  Pool: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('pg', () => ({ Pool: mocks.Pool }));

const originalArgv = [...process.argv];
const args = [
  '--issuer',
  'https://id.example.com/realms/openmaic',
  '--subject',
  'external-subject',
  '--role',
  'member',
];

describe('enterprise user provisioning safety', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test-db/openmaic');
    process.argv.splice(0, process.argv.length, 'node', 'provision-enterprise-user.mjs', ...args);
    mocks.Pool.mockReset().mockImplementation(function MockPool() {
      return { connect: mocks.connect, end: mocks.end };
    } as never);
    mocks.connect.mockReset().mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockReset().mockResolvedValue({ rows: [] });
    mocks.release.mockReset();
    mocks.end.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    vi.unstubAllEnvs();
  });

  async function runProvisioner() {
    return import('../../scripts/provision-enterprise-user.mjs');
  }

  it('rolls back rather than silently accepting a different existing membership role', async () => {
    process.argv.push('--user-id', 'existing-user');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, status FROM app_users')) {
        return { rowCount: 1, rows: [{ id: 'existing-user', status: 'active' }] };
      }
      if (sql.includes('SELECT role, status FROM tenant_memberships')) {
        return { rows: [{ role: 'viewer', status: 'active' }] };
      }
      return { rows: [] };
    });

    await expect(runProvisioner()).rejects.toThrow(/existing default membership has role viewer/i);
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO external_identities'),
      [
        expect.any(String),
        'existing-user',
        'https://id.example.com/realms/openmaic',
        'external-subject',
        null,
      ],
    );
  });

  it('refuses disabled users before adding an external identity', async () => {
    process.argv.push('--user-id', 'disabled-user');
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('SELECT id, status FROM app_users')
        ? { rowCount: 1, rows: [{ id: 'disabled-user', status: 'disabled' }] }
        : { rows: [] },
    );

    await expect(runProvisioner()).rejects.toThrow(/identifies a disabled user/);
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO external_identities'),
      expect.anything(),
    );
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('does not add identities to a suspended default membership', async () => {
    process.argv.push('--user-id', 'suspended-user');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, status FROM app_users')) {
        return { rowCount: 1, rows: [{ id: 'suspended-user', status: 'active' }] };
      }
      if (sql.includes('SELECT role, status FROM tenant_memberships')) {
        return { rows: [{ role: 'member', status: 'suspended' }] };
      }
      return { rows: [] };
    });

    await expect(runProvisioner()).rejects.toThrow(/existing default membership is suspended/i);
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('creates a new user and exact issuer/subject identity with a default member role', async () => {
    process.argv.push('--email', 'snapshot@example.com');
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO tenant_memberships')
        ? { rows: [{ role: 'member', status: 'active' }] }
        : { rows: [] },
    );
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runProvisioner()).resolves.toBeDefined();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO external_identities'),
      [expect.any(String), expect.any(String), args[1], args[3], 'snapshot@example.com'],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (tenant_id, user_id) DO NOTHING'),
      [expect.any(String), 'member'],
    );
    expect(mocks.query).toHaveBeenCalledWith('COMMIT');
    expect(stdoutWrite).toHaveBeenCalled();
  });

  it('audits a brand-new grant as a CLI action with no acting user', async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO tenant_memberships')
        ? { rowCount: 1, rows: [{ role: 'member', status: 'active' }] }
        : { rows: [] },
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runProvisioner()).resolves.toBeDefined();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tenant_role_audit'),
      [expect.any(String), expect.any(String), 'member', 'provision-enterprise-user'],
    );
    expect(mocks.query).toHaveBeenCalledWith('COMMIT');
  });

  it('writes no audit row when an existing membership already matches the requested role', async () => {
    process.argv.push('--user-id', 'existing-user');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, status FROM app_users')) {
        return { rowCount: 1, rows: [{ id: 'existing-user', status: 'active' }] };
      }
      if (sql.includes('INSERT INTO tenant_memberships')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT role, status FROM tenant_memberships')) {
        return { rows: [{ role: 'member', status: 'active' }] };
      }
      return { rows: [] };
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runProvisioner()).resolves.toBeDefined();
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tenant_role_audit'),
      expect.anything(),
    );
  });

  it('rejects issuer URLs that cannot match OIDC realm configuration', async () => {
    process.argv[3] = 'https://id.example.com/realms/openmaic?tenant=default';

    await expect(runProvisioner()).rejects.toThrow(
      /issuer.*without credentials, query, or fragment/i,
    );
    expect(mocks.Pool).not.toHaveBeenCalled();
  });
});
