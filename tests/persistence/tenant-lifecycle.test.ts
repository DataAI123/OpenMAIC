import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the tenant lifecycle guards against a real PostgreSQL engine
 * (PGlite): rename, suspend/activate, the unaudited no-op rule, and the
 * self-scoped tenant list. The HTTP mapping is covered by the route tests.
 */
class PGlitePool {
  constructor(readonly db: PGlite) {}

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params as never),
      release() {},
    };
  }
}

const migration = (name: string) => path.join(process.cwd(), 'migrations', name);

async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE stage_meta (
      stage_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      is_public BOOLEAN NOT NULL DEFAULT false,
      published_at DOUBLE PRECISION,
      generation_complete BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ
    );
  `);
  await db.exec(await readFile(migration('0001_enterprise_identity.sql'), 'utf8'));
  await db.exec(await readFile(migration('0017_tenant_role_audit.sql'), 'utf8'));
  await db.exec(await readFile(migration('0018_session_active_tenant.sql'), 'utf8'));
  return db;
}

interface TenantAuditRow {
  action: string;
  detail: string | null;
  source: string;
  tenant_id: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
}

describe('tenant lifecycle guards', () => {
  let db: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://tenant-lifecycle-${randomUUID()}`);
    db = await createDatabase();
    const pool = new PGlitePool(db);
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool }),
    }));
  });

  afterEach(async () => {
    vi.doUnmock('@/lib/persistence/server-provider');
    vi.unstubAllEnvs();
    await db.close();
  });

  async function seedUser(id: string, status = 'active') {
    await db.query('INSERT INTO app_users (id, status) VALUES ($1, $2)', [id, status]);
  }

  async function seedTenant(id: string, name: string, status = 'active') {
    await db.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1, $1, $2, $3)`, [
      id,
      name,
      status,
    ]);
  }

  async function join(tenantId: string, userId: string, role: string, status = 'active') {
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  async function adminAudit(): Promise<TenantAuditRow[]> {
    const result = await db.query<TenantAuditRow>(
      `SELECT action, detail, source, tenant_id, actor_user_id, subject_user_id
         FROM tenant_admin_audit ORDER BY created_at, id`,
    );
    return result.rows;
  }

  async function tenantRow(id: string): Promise<{ name: string; status: string } | undefined> {
    const result = await db.query<{ name: string; status: string }>(
      `SELECT name, status FROM tenants WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  }

  it('renames a tenant and audits the new name as an api rename', async () => {
    const { renameTenant } = await import('@/lib/server/auth/tenant-admin');
    await seedUser('owner-1');
    await seedTenant('acme', 'Acme');

    const renamed = await renameTenant({
      tenantId: 'acme',
      actorUserId: 'owner-1',
      name: ' Acme Inc ',
    });

    expect(renamed).toEqual({ tenantId: 'acme', name: 'Acme Inc' });
    expect(await tenantRow('acme')).toMatchObject({ name: 'Acme Inc' });
    expect(await adminAudit()).toEqual([
      {
        action: 'rename',
        detail: 'Acme Inc',
        source: 'api',
        tenant_id: 'acme',
        actor_user_id: 'owner-1',
        subject_user_id: null,
      },
    ]);
  });

  it('treats a rename to the current name as an unaudited no-op', async () => {
    const { renameTenant } = await import('@/lib/server/auth/tenant-admin');
    await seedUser('owner-1');
    await seedTenant('acme', 'Acme');

    await renameTenant({ tenantId: 'acme', actorUserId: 'owner-1', name: 'Acme' });

    expect(await adminAudit()).toEqual([]);
  });

  it('suspends and reactivates a tenant, auditing each transition', async () => {
    const { setTenantStatus } = await import('@/lib/server/auth/tenant-admin');
    await seedUser('owner-1');
    await seedTenant('acme', 'Acme');

    await setTenantStatus({ tenantId: 'acme', actorUserId: 'owner-1', status: 'suspended' });
    expect(await tenantRow('acme')).toMatchObject({ status: 'suspended' });

    await setTenantStatus({ tenantId: 'acme', actorUserId: 'owner-1', status: 'active' });
    expect(await tenantRow('acme')).toMatchObject({ status: 'active' });

    expect((await adminAudit()).map((row) => row.action)).toEqual(['suspend', 'activate']);
  });

  it('treats setting the status a tenant already has as an unaudited no-op', async () => {
    const { setTenantStatus } = await import('@/lib/server/auth/tenant-admin');
    await seedUser('owner-1');
    await seedTenant('acme', 'Acme', 'suspended');

    await setTenantStatus({ tenantId: 'acme', actorUserId: 'owner-1', status: 'suspended' });

    expect(await adminAudit()).toEqual([]);
  });

  it('answers not-found for an unknown tenant without writing', async () => {
    const { renameTenant, setTenantStatus, TenantAdminError } =
      await import('@/lib/server/auth/tenant-admin');
    await seedUser('owner-1');

    await expect(
      renameTenant({ tenantId: 'ghost', actorUserId: 'owner-1', name: 'Ghost' }),
    ).rejects.toBeInstanceOf(TenantAdminError);
    await expect(
      setTenantStatus({ tenantId: 'ghost', actorUserId: 'owner-1', status: 'suspended' }),
    ).rejects.toBeInstanceOf(TenantAdminError);
    expect(await adminAudit()).toEqual([]);
  });

  it('rejects an empty, oversized or control-character name before opening a transaction', async () => {
    const { renameTenant, TenantAdminError } = await import('@/lib/server/auth/tenant-admin');
    await seedUser('owner-1');
    await seedTenant('acme', 'Acme');

    for (const name of ['', '   ', 'Acme\nInc', 'x'.repeat(201), 42, null, undefined]) {
      await expect(
        renameTenant({ tenantId: 'acme', actorUserId: 'owner-1', name }),
        `name=${JSON.stringify(name)}`,
      ).rejects.toBeInstanceOf(TenantAdminError);
    }
    expect(await tenantRow('acme')).toMatchObject({ name: 'Acme' });
    expect(await adminAudit()).toEqual([]);
  });

  it('rejects an unknown status before opening a transaction', async () => {
    const { setTenantStatus, TenantAdminError } = await import('@/lib/server/auth/tenant-admin');
    await seedUser('owner-1');
    await seedTenant('acme', 'Acme');

    await expect(
      setTenantStatus({
        tenantId: 'acme',
        actorUserId: 'owner-1',
        status: 'deleted' as never,
      }),
    ).rejects.toBeInstanceOf(TenantAdminError);
    expect(await tenantRow('acme')).toMatchObject({ status: 'active' });
    expect(await adminAudit()).toEqual([]);
  });

  it('lists the caller active memberships with role and tenant status, skipping suspended ones', async () => {
    const { listTenantsForUser } = await import('@/lib/server/auth/tenant-admin');
    await seedUser('user-1');
    await seedTenant('alpha', 'Alpha');
    await seedTenant('beta', 'Beta', 'suspended');
    await seedTenant('gamma', 'Gamma');
    await join('alpha', 'user-1', 'owner');
    await join('beta', 'user-1', 'admin');
    await join('gamma', 'user-1', 'member', 'suspended');
    await join('default', 'user-1', 'viewer');

    const tenants = await listTenantsForUser('user-1');

    expect(tenants).toEqual([
      { tenantId: 'alpha', slug: 'alpha', name: 'Alpha', status: 'active', role: 'owner' },
      { tenantId: 'beta', slug: 'beta', name: 'Beta', status: 'suspended', role: 'admin' },
      {
        tenantId: 'default',
        slug: 'default',
        name: 'Default organization',
        status: 'active',
        role: 'viewer',
      },
    ]);
  });

  it('lists nothing for a user with no active membership', async () => {
    const { listTenantsForUser } = await import('@/lib/server/auth/tenant-admin');
    await seedUser('user-1');
    await seedTenant('gamma', 'Gamma');
    await join('gamma', 'user-1', 'member', 'suspended');

    expect(await listTenantsForUser('user-1')).toEqual([]);
  });
});
