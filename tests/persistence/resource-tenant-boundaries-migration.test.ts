import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const identityMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0001_enterprise_identity.sql',
);
const boundariesMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0019_resource_tenant_boundaries.sql',
);

/**
 * 0001 alters the pre-existing `stage_meta`, and 0019 alters the package-owned
 * `document_folders` / `document_stages`, so the test database has to provide
 * the shape the earlier deployment left behind — including the `tenants` table
 * the new foreign key points at.
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
  await db.exec(`
    CREATE TABLE document_folders (
      owner_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (owner_id, id)
    );
    CREATE TABLE document_stages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT,
      data JSONB NOT NULL
    );
  `);
  return db;
}

describe('resource tenant boundaries migration', () => {
  it('backfills legacy rows into the default tenant and scopes new rows to it', async () => {
    const db = await createDatabase();
    try {
      await db.exec(`
        INSERT INTO document_folders (owner_id, id, name) VALUES ('user:alice', 'folder-1', 'One');
        INSERT INTO document_stages (id, name, owner_id, data)
        VALUES ('stage-1', 'One', 'user:alice', '{}'::jsonb);
      `);

      await db.exec(await readFile(boundariesMigrationPath, 'utf8'));

      const folders = await db.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM document_folders WHERE id = 'folder-1'`,
      );
      const stages = await db.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM document_stages WHERE id = 'stage-1'`,
      );
      expect(folders.rows[0]?.tenant_id).toBe('default');
      expect(stages.rows[0]?.tenant_id).toBe('default');

      // The column is NOT NULL with the sentinel default, so the package's
      // existing INSERTs keep working without naming a tenant.
      await db.exec(`
        INSERT INTO document_stages (id, name, owner_id, data)
        VALUES ('stage-2', 'Two', 'user:alice', '{}'::jsonb);
      `);
      const stamped = await db.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM document_stages WHERE id = 'stage-2'`,
      );
      expect(stamped.rows[0]?.tenant_id).toBe('default');

      await expect(
        db.exec(`INSERT INTO document_stages (id, name, owner_id, data, tenant_id)
                 VALUES ('stage-bad', 'Bad', 'user:alice', '{}'::jsonb, NULL)`),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('is idempotent when replayed', async () => {
    const db = await createDatabase();
    try {
      const sql = await readFile(boundariesMigrationPath, 'utf8');
      await db.exec(sql);
      // PGlite returns the statement results rather than undefined, so the
      // replayed migration is asserted by not throwing rather than by a
      // specific resolution value.
      await db.exec(sql);
    } finally {
      await db.close();
    }
  });
});
