import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const identityMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0001_enterprise_identity.sql',
);
const auditMigrationPath = path.join(process.cwd(), 'migrations', '0017_tenant_role_audit.sql');

/**
 * The 0001 migration alters the pre-existing `stage_meta` table, so the test
 * database has to provide the shape the earlier deployment left behind before
 * any enterprise migration runs.
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
  await db.exec(await readFile(auditMigrationPath, 'utf8'));
  await db.exec(`
    INSERT INTO app_users (id, display_name) VALUES ('actor-1', 'Actor'), ('subject-1', 'Subject');
  `);
  return db;
}

describe('tenant role audit schema migration', () => {
  it('records a well-formed grant, change and revoke for the default tenant', async () => {
    const db = await createDatabase();
    try {
      await db.exec(`
        INSERT INTO tenant_role_audit
          (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source, reason)
        VALUES
          ('audit-grant', 'default', 'actor-1', 'subject-1', 'grant', NULL, 'member', 'api', 'first login'),
          ('audit-change', 'default', 'actor-1', 'subject-1', 'change', 'member', 'admin', 'api', NULL),
          ('audit-revoke', 'default', NULL, 'subject-1', 'revoke', 'admin', NULL, 'cli', 'offboarded');
      `);
      const rows = await db.query<{ id: string; action: string; source: string }>(
        'SELECT id, action, source FROM tenant_role_audit ORDER BY id',
      );
      expect(rows.rows).toEqual([
        { id: 'audit-change', action: 'change', source: 'api' },
        { id: 'audit-grant', action: 'grant', source: 'api' },
        { id: 'audit-revoke', action: 'revoke', source: 'cli' },
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects actions and sources outside the reviewed catalog', async () => {
    const db = await createDatabase();
    try {
      await expect(
        db.exec(`
          INSERT INTO tenant_role_audit
            (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source)
          VALUES ('bad-action', 'default', NULL, 'subject-1', 'promote', NULL, 'admin', 'api')
        `),
      ).rejects.toThrow();
      await expect(
        db.exec(`
          INSERT INTO tenant_role_audit
            (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source)
          VALUES ('bad-source', 'default', NULL, 'subject-1', 'grant', NULL, 'admin', 'migration')
        `),
      ).rejects.toThrow();
      await expect(
        db.exec(`
          INSERT INTO tenant_role_audit
            (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source)
          VALUES ('bad-role', 'default', NULL, 'subject-1', 'grant', NULL, 'superuser', 'api')
        `),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('keeps each action self-consistent with its role columns', async () => {
    const db = await createDatabase();
    try {
      const inconsistent = [
        // grant with a previous role
        "('shape-1', 'default', NULL, 'subject-1', 'grant', 'member', 'admin', 'api')",
        // grant without a new role
        "('shape-2', 'default', NULL, 'subject-1', 'grant', NULL, NULL, 'api')",
        // change without a previous role
        "('shape-3', 'default', NULL, 'subject-1', 'change', NULL, 'admin', 'api')",
        // change without a new role
        "('shape-4', 'default', NULL, 'subject-1', 'change', 'member', NULL, 'api')",
        // revoke without a previous role
        "('shape-5', 'default', NULL, 'subject-1', 'revoke', NULL, NULL, 'api')",
        // revoke carrying a new role
        "('shape-6', 'default', NULL, 'subject-1', 'revoke', 'member', 'viewer', 'api')",
      ];
      for (const values of inconsistent) {
        await expect(
          db.exec(`
            INSERT INTO tenant_role_audit
              (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source)
            VALUES ${values}
          `),
        ).rejects.toThrow();
      }
    } finally {
      await db.close();
    }
  });

  it('requires an existing tenant and subject, and preserves the row when a user is deleted', async () => {
    const db = await createDatabase();
    try {
      await expect(
        db.exec(`
          INSERT INTO tenant_role_audit
            (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source)
          VALUES ('bad-tenant', 'missing', NULL, 'subject-1', 'grant', NULL, 'member', 'api')
        `),
      ).rejects.toThrow();
      await expect(
        db.exec(`
          INSERT INTO tenant_role_audit
            (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source)
          VALUES ('bad-subject', 'default', NULL, 'missing', 'grant', NULL, 'member', 'api')
        `),
      ).rejects.toThrow();

      await db.exec(`
        INSERT INTO tenant_role_audit
          (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source)
        VALUES ('audit-keep', 'default', NULL, 'subject-1', 'grant', NULL, 'member', 'api');
      `);
      // RESTRICT keeps the audit trail from losing the user it describes.
      await expect(db.exec(`DELETE FROM app_users WHERE id = 'subject-1'`)).rejects.toThrow();
      await expect(db.exec(`DELETE FROM tenants WHERE id = 'default'`)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
