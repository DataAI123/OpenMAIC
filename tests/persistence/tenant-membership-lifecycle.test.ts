import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the membership lifecycle guards — suspend/resume and self-service
 * leave — against a real PostgreSQL engine (PGlite): the in-place status toggle,
 * the rank rule, the last-owner rule, the unaudited no-op, and the session
 * un-pinning that leave performs. The HTTP mapping is covered separately.
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

interface AdminAuditRow {
  action: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  detail: string | null;
}

describe('tenant membership lifecycle', () => {
  let db: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://tenant-membership-${randomUUID()}`);
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

  async function seedMembership(
    userId: string,
    role: string,
    status = 'active',
    tenantId = 'default',
  ) {
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, role, status],
    );
  }

  async function membershipStatus(userId: string): Promise<string | undefined> {
    const result = await db.query<{ status: string }>(
      `SELECT status FROM tenant_memberships WHERE tenant_id = 'default' AND user_id = $1`,
      [userId],
    );
    return result.rows[0]?.status;
  }

  async function auditRows(): Promise<AdminAuditRow[]> {
    const result = await db.query<AdminAuditRow>(
      `SELECT action, actor_user_id, subject_user_id, detail
         FROM tenant_admin_audit ORDER BY created_at, id`,
    );
    return result.rows;
  }

  async function seedSession(sid: string, userId: string, activeTenantId: string | null) {
    await db.query(
      `INSERT INTO auth_sessions (sid, user_id, issuer, expires_at, active_tenant_id)
       VALUES ($1, $2, 'https://id.example.com/realms/openmaic', now() + interval '1 hour', $3)`,
      [sid, userId, activeTenantId],
    );
  }

  it('suspends a membership in place and audits the suspend', async () => {
    await seedUser('actor');
    await seedUser('subject');
    await seedMembership('actor', 'owner');
    await seedMembership('subject', 'member');
    const { suspendMembership } = await import('@/lib/server/auth/tenant-admin');

    const changed = await suspendMembership({
      tenantId: 'default',
      actorUserId: 'actor',
      actorRole: 'owner',
      subjectUserId: 'subject',
      reason: 'under review',
    });

    expect(changed).toEqual({ userId: 'subject', role: 'member', status: 'suspended' });
    // The row survives; only its status moved.
    expect(await membershipStatus('subject')).toBe('suspended');
    expect(await auditRows()).toEqual([
      {
        action: 'membership_suspend',
        actor_user_id: 'actor',
        subject_user_id: 'subject',
        detail: 'under review',
      },
    ]);
  });

  it('resumes a suspended membership and audits the resume', async () => {
    await seedUser('actor');
    await seedUser('subject');
    await seedMembership('actor', 'owner');
    await seedMembership('subject', 'admin', 'suspended');
    const { resumeMembership } = await import('@/lib/server/auth/tenant-admin');

    const changed = await resumeMembership({
      tenantId: 'default',
      actorUserId: 'actor',
      actorRole: 'owner',
      subjectUserId: 'subject',
      reason: null,
    });

    expect(changed).toEqual({ userId: 'subject', role: 'admin', status: 'active' });
    expect(await membershipStatus('subject')).toBe('active');
    expect(await auditRows()).toEqual([
      {
        action: 'membership_resume',
        actor_user_id: 'actor',
        subject_user_id: 'subject',
        detail: null,
      },
    ]);
  });

  it('treats a status change to the current status as an unaudited no-op', async () => {
    await seedUser('actor');
    await seedUser('subject');
    await seedMembership('actor', 'owner');
    await seedMembership('subject', 'member', 'suspended');
    const { suspendMembership, resumeMembership } = await import('@/lib/server/auth/tenant-admin');

    // Already suspended: suspending again changes nothing.
    await expect(
      suspendMembership({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'subject',
        reason: null,
      }),
    ).resolves.toMatchObject({ status: 'suspended' });
    // Already active: resuming again changes nothing.
    await expect(
      resumeMembership({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'actor',
        reason: null,
      }),
    ).resolves.toMatchObject({ status: 'active' });

    expect(await auditRows()).toEqual([]);
  });

  it('refuses to suspend the last active owner', async () => {
    await seedUser('actor');
    await seedMembership('actor', 'owner');
    const { suspendMembership } = await import('@/lib/server/auth/tenant-admin');

    await expect(
      suspendMembership({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'actor',
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });

    expect(await membershipStatus('actor')).toBe('active');
    expect(await auditRows()).toEqual([]);
  });

  it('lets an owner suspend a peer owner while another active owner remains', async () => {
    await seedUser('actor');
    await seedUser('peer');
    await seedMembership('actor', 'owner');
    await seedMembership('peer', 'owner');
    const { suspendMembership } = await import('@/lib/server/auth/tenant-admin');

    await expect(
      suspendMembership({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'peer',
        reason: null,
      }),
    ).resolves.toMatchObject({ status: 'suspended' });
    expect((await auditRows()).map((row) => row.action)).toEqual(['membership_suspend']);
  });

  it('refuses an admin that suspends a peer admin or an owner', async () => {
    await seedUser('actor');
    await seedUser('peer');
    await seedUser('boss');
    await seedMembership('actor', 'admin');
    await seedMembership('peer', 'admin');
    await seedMembership('boss', 'owner');
    const { suspendMembership } = await import('@/lib/server/auth/tenant-admin');

    for (const subjectUserId of ['peer', 'boss']) {
      await expect(
        suspendMembership({
          tenantId: 'default',
          actorUserId: 'actor',
          actorRole: 'admin',
          subjectUserId,
          reason: null,
        }),
      ).rejects.toMatchObject({ reason: 'forbidden' });
    }

    expect(await membershipStatus('peer')).toBe('active');
    expect(await membershipStatus('boss')).toBe('active');
    expect(await auditRows()).toEqual([]);
  });

  it('answers not-found for a subject with no membership here', async () => {
    await seedUser('actor');
    await seedUser('ghost');
    await seedMembership('actor', 'owner');
    const { suspendMembership } = await import('@/lib/server/auth/tenant-admin');

    await expect(
      suspendMembership({
        tenantId: 'default',
        actorUserId: 'actor',
        actorRole: 'owner',
        subjectUserId: 'ghost',
        reason: null,
      }),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(await auditRows()).toEqual([]);
  });

  it('leaves a tenant: removes the membership, un-pins sessions and audits as self', async () => {
    await seedUser('actor');
    await seedUser('stayer');
    await seedMembership('actor', 'member');
    await seedMembership('stayer', 'owner');
    await seedSession('s-pinned', 'actor', 'default');
    await seedSession('s-other', 'stayer', 'default');
    const { leaveTenant } = await import('@/lib/server/auth/tenant-admin');

    await expect(
      leaveTenant({ userId: 'actor', tenantId: 'default', reason: 'moving on' }),
    ).resolves.toEqual({ tenantId: 'default', previousRole: 'member' });

    const remaining = await db.query(
      `SELECT 1 FROM tenant_memberships WHERE tenant_id = 'default' AND user_id = 'actor'`,
    );
    expect(remaining.rows).toEqual([]);
    // The leaver's own pin is cleared so the next request lands in tenant
    // selection; another user's session is untouched.
    const leaverSession = await db.query<{ active_tenant_id: string | null }>(
      `SELECT active_tenant_id FROM auth_sessions WHERE sid = 's-pinned'`,
    );
    expect(leaverSession.rows[0]?.active_tenant_id).toBeNull();
    const otherSession = await db.query<{ active_tenant_id: string | null }>(
      `SELECT active_tenant_id FROM auth_sessions WHERE sid = 's-other'`,
    );
    expect(otherSession.rows[0]?.active_tenant_id).toBe('default');
    expect(await auditRows()).toEqual([
      {
        action: 'leave',
        actor_user_id: 'actor',
        subject_user_id: 'actor',
        detail: 'moving on',
      },
    ]);
  });

  it('lets an owner leave only when another active owner remains', async () => {
    await seedUser('sole');
    await seedUser('paired');
    await seedMembership('sole', 'owner');
    await seedMembership('paired', 'owner');
    await seedSession('s-sole', 'sole', 'default');
    const { leaveTenant } = await import('@/lib/server/auth/tenant-admin');

    // Two owners: one may leave.
    await expect(
      leaveTenant({ userId: 'paired', tenantId: 'default', reason: null }),
    ).resolves.toEqual({ tenantId: 'default', previousRole: 'owner' });

    // Now `sole` is the last owner and cannot leave.
    await expect(
      leaveTenant({ userId: 'sole', tenantId: 'default', reason: null }),
    ).rejects.toMatchObject({ reason: 'conflict' });

    // The refused leave left the sole owner's binding in place.
    expect(await membershipStatus('sole')).toBe('active');
    const soleRole = await db.query<{ role: string }>(
      `SELECT role FROM tenant_memberships WHERE tenant_id = 'default' AND user_id = 'sole'`,
    );
    expect(soleRole.rows[0]?.role).toBe('owner');
    const session = await db.query<{ active_tenant_id: string | null }>(
      `SELECT active_tenant_id FROM auth_sessions WHERE sid = 's-sole'`,
    );
    expect(session.rows[0]?.active_tenant_id).toBe('default');
    expect((await auditRows()).map((row) => row.action)).toEqual(['leave']);
  });

  it('answers not-found when leaving a tenant the caller is not an active member of', async () => {
    await seedUser('actor');
    await seedUser('owner');
    await seedMembership('actor', 'member', 'suspended');
    await seedMembership('owner', 'owner');
    await seedSession('s-1', 'actor', 'default');
    const { leaveTenant } = await import('@/lib/server/auth/tenant-admin');

    // A suspended binding and an absent one are indistinguishable.
    await expect(
      leaveTenant({ userId: 'actor', tenantId: 'default', reason: null }),
    ).rejects.toMatchObject({ reason: 'not-found' });
    await expect(
      leaveTenant({ userId: 'ghost', tenantId: 'default', reason: null }),
    ).rejects.toMatchObject({ reason: 'not-found' });

    expect(await membershipStatus('actor')).toBe('suspended');
    const session = await db.query<{ active_tenant_id: string | null }>(
      `SELECT active_tenant_id FROM auth_sessions WHERE sid = 's-1'`,
    );
    expect(session.rows[0]?.active_tenant_id).toBe('default');
    expect(await auditRows()).toEqual([]);
  });
});
