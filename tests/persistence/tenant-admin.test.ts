import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the tenant-role guards against a real PostgreSQL engine (PGlite):
 * the rank rule, the last-owner rule, the per-tenant advisory lock, and the
 * audit rows. The HTTP mapping is covered separately by the route tests.
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

/**
 * Migration 0001 alters the pre-existing `stage_meta` table, so the test
 * database has to provide the shape the earlier deployment left behind.
 */
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

interface AuditRow {
  action: string;
  previous_role: string | null;
  new_role: string | null;
  source: string;
  actor_user_id: string | null;
  subject_user_id: string;
  reason: string | null;
}

describe('tenant role administration guards', () => {
  let db: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://tenant-admin-${randomUUID()}`);
    db = await createDatabase();
    const pool = new PGlitePool(db);
    // `lib/server/auth/tenant-admin.ts` resolves its pool through this module;
    // the PGlite-backed pool keeps the guards under test without a live server.
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool }),
    }));
  });

  afterEach(async () => {
    vi.doUnmock('@/lib/persistence/server-provider');
    vi.unstubAllEnvs();
    await db.close();
  });

  async function seedUser(id: string, role?: string, status = 'active') {
    await db.query('INSERT INTO app_users (id, status) VALUES ($1, $2)', [id, status]);
    if (role) {
      await db.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
         VALUES ('default', $1, $2, 'active')`,
        [id, role],
      );
    }
  }

  async function auditRows(subject?: string): Promise<AuditRow[]> {
    const result = await db.query<AuditRow>(
      subject
        ? `SELECT action, previous_role, new_role, source, actor_user_id, subject_user_id, reason
             FROM tenant_role_audit WHERE subject_user_id = $1 ORDER BY created_at, id`
        : `SELECT action, previous_role, new_role, source, actor_user_id, subject_user_id, reason
             FROM tenant_role_audit ORDER BY created_at, id`,
      subject ? [subject] : undefined,
    );
    return result.rows;
  }

  it('grants a new membership and audits it as an api grant', async () => {
    await seedUser('actor', 'owner');
    await seedUser('subject');
    const { assignTenantRole } = await import('@/lib/server/auth/tenant-admin');

    const member = await assignTenantRole({
      tenantId: 'default',
      actorUserId: 'actor',
      actorRole: 'owner',
      subjectUserId: 'subject',
      role: 'member',
      reason: 'onboarding',
    });

    expect(member).toMatchObject({ userId: 'subject', role: 'member', status: 'active' });
    expect(await auditRows()).toEqual([
      {
        action: 'grant',
        previous_role: null,
        new_role: 'member',
        source: 'api',
        actor_user_id: 'actor',
        subject_user_id: 'subject',
        reason: 'onboarding',
      },
    ]);
  });

  it('records the previous role when changing an existing membership', async () => {
    await seedUser('actor', 'owner');
    await seedUser('subject', 'member');
    const { assignTenantRole } = await import('@/lib/server/auth/tenant-admin');

    await assignTenantRole({
      tenantId: 'default',
      actorUserId: 'actor',
      actorRole: 'owner',
      subjectUserId: 'subject',
      role: 'admin',
      reason: null,
    });

    expect(await auditRows('subject')).toEqual([
      {
        action: 'change',
        previous_role: 'member',
        new_role: 'admin',
        source: 'api',
        actor_user_id: 'actor',
        subject_user_id: 'subject',
        reason: null,
      },
    ]);
    const membership = await db.query<{ role: string }>(
      `SELECT role FROM tenant_memberships WHERE tenant_id = 'default' AND user_id = 'subject'`,
    );
    expect(membership.rows[0]?.role).toBe('admin');
  });

  it('treats a re-assignment that changes nothing as an unaudited no-op', async () => {
    await seedUser('actor', 'owner');
    await seedUser('subject', 'member');
    const { assignTenantRole } = await import('@/lib/server/auth/tenant-admin');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assignTenantRole({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'subject',
        role: 'member',
        reason: null,
      });
    }

    expect(await auditRows()).toEqual([]);
  });

  it('refuses an admin that grants its own rank or above, or modifies an admin', async () => {
    await seedUser('actor', 'admin');
    await seedUser('subject');
    await seedUser('other-admin', 'admin');
    const { assignTenantRole } = await import('@/lib/server/auth/tenant-admin');

    const attempted = async (subjectUserId: string, role: 'owner' | 'admin') =>
      assignTenantRole({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'admin',
        subjectUserId,
        role,
        reason: null,
      });

    await expect(attempted('subject', 'admin')).rejects.toMatchObject({ reason: 'forbidden' });
    await expect(attempted('subject', 'owner')).rejects.toMatchObject({ reason: 'forbidden' });
    // An admin cannot demote or otherwise touch a peer admin either.
    await expect(
      assignTenantRole({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'admin',
        subjectUserId: 'other-admin',
        role: 'member',
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'forbidden' });

    // Nothing was written on any refused path.
    expect(await auditRows()).toEqual([]);
    const memberships = await db.query<{ user_id: string }>(
      `SELECT user_id FROM tenant_memberships ORDER BY user_id`,
    );
    expect(memberships.rows.map((row) => row.user_id)).toEqual(['actor', 'other-admin']);
  });

  it('lets an admin bind a role strictly below its own', async () => {
    await seedUser('actor', 'admin');
    await seedUser('subject');
    const { assignTenantRole } = await import('@/lib/server/auth/tenant-admin');

    const member = await assignTenantRole({
      tenantId: 'default',
      actorUserId: 'actor',
      actorRole: 'admin',
      subjectUserId: 'subject',
      role: 'viewer',
      reason: null,
    });
    expect(member.role).toBe('viewer');
    expect((await auditRows()).map((row) => row.action)).toEqual(['grant']);
  });

  it('protects the last active owner from demotion and from removal', async () => {
    await seedUser('actor', 'owner');
    await seedUser('subject', 'owner');
    const { assignTenantRole, revokeTenantMembership } =
      await import('@/lib/server/auth/tenant-admin');

    // Two owners: demoting one still leaves an owner.
    await assignTenantRole({
      tenantId: 'default',
      actorUserId: 'actor',
      actorRole: 'owner',
      subjectUserId: 'subject',
      role: 'admin',
      reason: null,
    });

    // Now `actor` is the only active owner and cannot demote or remove itself.
    await expect(
      assignTenantRole({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'actor',
        role: 'admin',
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });
    await expect(
      revokeTenantMembership({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'actor',
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });

    // The refused paths left the sole owner and the audit trail untouched.
    const owner = await db.query<{ role: string }>(
      `SELECT role FROM tenant_memberships WHERE user_id = 'actor'`,
    );
    expect(owner.rows[0]?.role).toBe('owner');
    expect((await auditRows()).map((row) => row.action)).toEqual(['change']);
  });

  it('removes a membership and audits the revoke', async () => {
    await seedUser('actor', 'owner');
    await seedUser('subject', 'member');
    const { revokeTenantMembership } = await import('@/lib/server/auth/tenant-admin');

    const revoked = await revokeTenantMembership({
      tenantId: 'default',
      actorUserId: 'actor',
      actorRole: 'owner',
      subjectUserId: 'subject',
      reason: 'offboarded',
    });

    expect(revoked).toEqual({ userId: 'subject', previousRole: 'member' });
    const remaining = await db.query(
      `SELECT 1 FROM tenant_memberships WHERE tenant_id = 'default' AND user_id = 'subject'`,
    );
    expect(remaining.rows).toEqual([]);
    expect(await auditRows('subject')).toEqual([
      {
        action: 'revoke',
        previous_role: 'member',
        new_role: null,
        source: 'api',
        actor_user_id: 'actor',
        subject_user_id: 'subject',
        reason: 'offboarded',
      },
    ]);
  });

  it('answers not-found for an unknown or disabled subject and for a missing membership', async () => {
    await seedUser('actor', 'owner');
    await seedUser('disabled-user', undefined, 'disabled');
    const { assignTenantRole, revokeTenantMembership } =
      await import('@/lib/server/auth/tenant-admin');

    await expect(
      assignTenantRole({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'ghost',
        role: 'member',
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'not-found' });
    await expect(
      assignTenantRole({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'disabled-user',
        role: 'member',
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'not-found' });
    await expect(
      revokeTenantMembership({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'ghost',
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'not-found' });

    expect(await auditRows()).toEqual([]);
  });

  it('rejects an unknown role before opening a transaction', async () => {
    await seedUser('actor', 'owner');
    await seedUser('subject');
    const { assignTenantRole } = await import('@/lib/server/auth/tenant-admin');

    await expect(
      assignTenantRole({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'subject',
        role: 'superuser' as never,
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'invalid-request' });
    expect(await auditRows()).toEqual([]);
  });

  it('lists members and bounds the audit read', async () => {
    await seedUser('actor', 'owner');
    await seedUser('subject', 'member');
    const { assignTenantRole, listTenantMembers, listTenantRoleAudit } =
      await import('@/lib/server/auth/tenant-admin');

    const members = await listTenantMembers('default');
    expect(members.map((member) => [member.userId, member.role])).toEqual([
      ['actor', 'owner'],
      ['subject', 'member'],
    ]);

    await assignTenantRole({
      tenantId: 'default',
      actorUserId: 'actor',
      actorRole: 'owner',
      subjectUserId: 'subject',
      role: 'admin',
      reason: null,
    });
    const audit = await listTenantRoleAudit('default');
    expect(audit.map((entry) => entry.action)).toEqual(['change']);
    expect(audit[0]).toMatchObject({ previousRole: 'member', newRole: 'admin', source: 'api' });

    // A non-positive or oversized limit falls back to the bounded default.
    expect(await listTenantRoleAudit('default', 0)).toHaveLength(1);
  });

  async function seedSession(sid: string, userId: string, activeTenantId: string | null) {
    await db.query(
      `INSERT INTO auth_sessions (sid, user_id, issuer, expires_at, active_tenant_id)
       VALUES ($1, $2, 'https://id.example.com/realms/openmaic', now() + interval '1 hour', $3)`,
      [sid, userId, activeTenantId],
    );
  }

  async function adminAuditRows(): Promise<
    { action: string; actor_user_id: string | null; subject_user_id: string | null }[]
  > {
    const result = await db.query<{
      action: string;
      actor_user_id: string | null;
      subject_user_id: string | null;
    }>(
      `SELECT action, actor_user_id, subject_user_id FROM tenant_admin_audit ORDER BY created_at, id`,
    );
    return result.rows;
  }

  it('switches a session to another active tenant and audits the change', async () => {
    await seedUser('actor', 'owner');
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ('second', 'second', 'Second')`);
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ('second', 'actor', 'member')`,
    );
    await seedSession('s-1', 'actor', 'default');
    const { switchActiveTenant } = await import('@/lib/server/auth/tenant-admin');

    await expect(
      switchActiveTenant({ sessionId: 's-1', userId: 'actor', tenantId: 'second' }),
    ).resolves.toEqual({ tenantId: 'second' });

    const session = await db.query<{ active_tenant_id: string }>(
      `SELECT active_tenant_id FROM auth_sessions WHERE sid = 's-1'`,
    );
    expect(session.rows[0]?.active_tenant_id).toBe('second');
    expect(await adminAuditRows()).toEqual([
      { action: 'switch', actor_user_id: 'actor', subject_user_id: null },
    ]);
  });

  it('treats a switch to the current tenant as an unaudited no-op', async () => {
    await seedUser('actor', 'owner');
    await seedSession('s-1', 'actor', 'default');
    const { switchActiveTenant } = await import('@/lib/server/auth/tenant-admin');

    await expect(
      switchActiveTenant({ sessionId: 's-1', userId: 'actor', tenantId: 'default' }),
    ).resolves.toEqual({ tenantId: 'default' });
    expect(await adminAuditRows()).toEqual([]);
  });

  it('refuses a tenant the user is not an active member of without writing', async () => {
    await seedUser('actor', 'owner');
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ('second', 'second', 'Second')`);
    await seedSession('s-1', 'actor', 'default');
    const { switchActiveTenant } = await import('@/lib/server/auth/tenant-admin');

    await expect(
      switchActiveTenant({ sessionId: 's-1', userId: 'actor', tenantId: 'second' }),
    ).rejects.toMatchObject({ reason: 'not-found' });

    const session = await db.query<{ active_tenant_id: string }>(
      `SELECT active_tenant_id FROM auth_sessions WHERE sid = 's-1'`,
    );
    expect(session.rows[0]?.active_tenant_id).toBe('default');
    expect(await adminAuditRows()).toEqual([]);
  });
});
