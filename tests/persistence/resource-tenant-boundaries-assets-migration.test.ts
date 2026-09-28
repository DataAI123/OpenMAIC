import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'migrations',
  '0021_resource_tenant_boundaries_assets.sql',
);

/**
 * 0021 alters four pre-existing tables, so the test database has to provide the
 * shape the earlier deployment left behind -- the four tables themselves and the
 * `tenants` table the new foreign keys point at (created by 0001 in a real
 * deployment).
 */
async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE tenants (
      id   TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL
    );
    INSERT INTO tenants (id, slug, name) VALUES ('default', 'default', 'Default');

    CREATE TABLE asset_entries (
      id        TEXT PRIMARY KEY,
      principal TEXT NOT NULL
    );
    CREATE TABLE owner_material (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL,
      created_at DOUBLE PRECISION NOT NULL
    );
    CREATE TABLE export_render_job_owners (
      job_id     TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE agent_owner_session_events (
      owner_id   TEXT NOT NULL,
      id         BIGINT NOT NULL,
      PRIMARY KEY (owner_id, id)
    );
  `);
  return db;
}

describe('asset / material / render-job tenant boundaries migration', () => {
  it('backfills legacy user rows into the default tenant and leaves anon rows NULL', async () => {
    const db = await createDatabase();
    try {
      await db.exec(`
        INSERT INTO asset_entries (id, principal) VALUES ('asset-user', 'user:alice');
        INSERT INTO asset_entries (id, principal) VALUES ('asset-anon', 'anon:cookie');
        INSERT INTO owner_material (id, owner_id, created_at)
        VALUES ('mat-user', 'user:alice', 1);
        INSERT INTO owner_material (id, owner_id, created_at)
        VALUES ('mat-anon', 'anon:cookie', 1);
        INSERT INTO export_render_job_owners (job_id, owner_id)
        VALUES ('job-user', 'user:alice'), ('job-anon', 'anon:cookie');
        INSERT INTO agent_owner_session_events (owner_id, id)
        VALUES ('user:alice', 1), ('anon:cookie', 2);
      `);

      await db.exec(await readFile(migrationPath, 'utf8'));

      const assetUser = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM asset_entries WHERE id = 'asset-user'`,
      );
      const assetAnon = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM asset_entries WHERE id = 'asset-anon'`,
      );
      expect(assetUser.rows[0]?.tenant_id).toBe('default');
      expect(assetAnon.rows[0]?.tenant_id).toBeNull();

      const materialUser = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM owner_material WHERE id = 'mat-user'`,
      );
      const materialAnon = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM owner_material WHERE id = 'mat-anon'`,
      );
      expect(materialUser.rows[0]?.tenant_id).toBe('default');
      expect(materialAnon.rows[0]?.tenant_id).toBeNull();

      const jobUser = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM export_render_job_owners WHERE job_id = 'job-user'`,
      );
      const jobAnon = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM export_render_job_owners WHERE job_id = 'job-anon'`,
      );
      expect(jobUser.rows[0]?.tenant_id).toBe('default');
      expect(jobAnon.rows[0]?.tenant_id).toBeNull();

      const eventUser = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM agent_owner_session_events WHERE id = 1`,
      );
      const eventAnon = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM agent_owner_session_events WHERE id = 2`,
      );
      expect(eventUser.rows[0]?.tenant_id).toBe('default');
      expect(eventAnon.rows[0]?.tenant_id).toBeNull();

      // The foreign key is real: an unknown tenant id is refused.
      await expect(
        db.exec(`INSERT INTO asset_entries (id, principal, tenant_id)
                 VALUES ('asset-bad', 'user:alice', 'nope')`),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('is idempotent when replayed', async () => {
    const db = await createDatabase();
    try {
      const sql = await readFile(migrationPath, 'utf8');
      await db.exec(sql);
      // PGlite returns statement results rather than undefined, so the replayed
      // migration is asserted by not throwing rather than by a resolution value.
      await db.exec(sql);
    } finally {
      await db.close();
    }
  });
});
