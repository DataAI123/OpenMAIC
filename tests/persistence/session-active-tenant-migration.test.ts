import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const identityMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0001_enterprise_identity.sql',
);
const activeTenantMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0018_session_active_tenant.sql',
);

/**
 * 0001 alters the pre-existing `stage_meta` table, so the test database has to
 * provide the shape the earlier deployment left behind before any enterprise
 * migration runs.
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
  await db.exec(await readFile(identityMigrationPath, 'utf8'));
  return db;
}

describe('session active tenant migration', () => {
  it('backfills a live session only when the membership is unambiguous', async () => {
    const db = await createDatabase();
    try {
      await db.exec(`
        INSERT INTO app_users (id, display_name) VALUES ('solo', 'Solo'), ('multi', 'Multi');
        INSERT INTO tenants (id, slug, name) VALUES ('second', 'second', 'Second');
        INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES
          ('default', 'solo', 'member'),
          ('default', 'multi', 'member'),
          ('second', 'multi', 'owner');
        INSERT INTO auth_sessions (sid, user_id, issuer, expires_at) VALUES
          ('s-solo', 'solo', 'https://id.example.com/realms/openmaic', now() + interval '1 hour'),
          ('s-multi', 'multi', 'https://id.example.com/realms/openmaic', now() + interval '1 hour');
      `);
      await db.exec(await readFile(activeTenantMigrationPath, 'utf8'));

      const rows = await db.query<{ sid: string; active_tenant_id: string | null }>(
        'SELECT sid, active_tenant_id FROM auth_sessions ORDER BY sid',
      );
      expect(rows.rows).toEqual([
        // Two active memberships: the migration refuses to guess.
        { sid: 's-multi', active_tenant_id: null },
        { sid: 's-solo', active_tenant_id: 'default' },
      ]);
    } finally {
      await db.close();
    }
  });

  it('does not backfill a sole membership that is suspended', async () => {
    const db = await createDatabase();
    try {
      await db.exec(`
        INSERT INTO app_users (id, display_name) VALUES ('paused', 'Paused');
        INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('default', 'paused', 'member', 'suspended');
        INSERT INTO auth_sessions (sid, user_id, issuer, expires_at)
        VALUES ('s-paused', 'paused', 'https://id.example.com/realms/openmaic', now() + interval '1 hour');
      `);
      await db.exec(await readFile(activeTenantMigrationPath, 'utf8'));

      const rows = await db.query<{ active_tenant_id: string | null }>(
        `SELECT active_tenant_id FROM auth_sessions WHERE sid = 's-paused'`,
      );
      expect(rows.rows[0]?.active_tenant_id).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('records tenant lifecycle actions with a restricted action and source catalog', async () => {
    const db = await createDatabase();
    try {
      await db.exec(await readFile(activeTenantMigrationPath, 'utf8'));
      await db.exec(`
        INSERT INTO app_users (id, display_name) VALUES ('actor-1', 'Actor'), ('subject-1', 'Subject');
        INSERT INTO tenant_admin_audit (id, tenant_id, actor_user_id, subject_user_id, action, source)
        VALUES
          ('a-switch', 'default', 'actor-1', 'subject-1', 'switch', 'api'),
          ('a-create', 'default', 'actor-1', NULL, 'create', 'cli');
      `);
      const rows = await db.query<{ id: string; subject_user_id: string | null }>(
        'SELECT id, subject_user_id FROM tenant_admin_audit ORDER BY id',
      );
      expect(rows.rows).toEqual([
        { id: 'a-create', subject_user_id: null },
        { id: 'a-switch', subject_user_id: 'subject-1' },
      ]);

      await expect(
        db.exec(`
          INSERT INTO tenant_admin_audit (id, tenant_id, action, source)
          VALUES ('bad-action', 'default', 'promote', 'api')
        `),
      ).rejects.toThrow();
      await expect(
        db.exec(`
          INSERT INTO tenant_admin_audit (id, tenant_id, action, source)
          VALUES ('bad-source', 'default', 'switch', 'migration')
        `),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('keeps the tenant referenced by a live session from being deleted', async () => {
    const db = await createDatabase();
    try {
      await db.exec(`
        INSERT INTO app_users (id, display_name) VALUES ('member-1', 'Member');
        INSERT INTO tenants (id, slug, name) VALUES ('second', 'second', 'Second');
        INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ('second', 'member-1', 'owner');
        INSERT INTO auth_sessions (sid, user_id, issuer, expires_at)
        VALUES ('s-1', 'member-1', 'https://id.example.com/realms/openmaic', now() + interval '1 hour');
      `);
      await db.exec(await readFile(activeTenantMigrationPath, 'utf8'));
      await db.exec(`UPDATE auth_sessions SET active_tenant_id = 'second' WHERE sid = 's-1'`);

      await expect(db.exec(`DELETE FROM tenants WHERE id = 'second'`)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
