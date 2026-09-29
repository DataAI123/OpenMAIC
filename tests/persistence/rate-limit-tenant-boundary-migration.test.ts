import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = (file: string) => path.join(process.cwd(), 'migrations', file);

const PRE_RATE_LIMIT_TENANT = ['0001_enterprise_identity.sql', '0003_user_api_rate_limits.sql'];
const RATE_LIMIT_TENANT_MIGRATION = '0023_rate_limit_tenant_boundary.sql';

// 0001 assumes `stage_meta` already exists (it alters it), so the harness seeds
// the shape an earlier deployment left behind before replaying the migrations.
const STAGE_META = `
  CREATE TABLE stage_meta (
    stage_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    is_public BOOLEAN NOT NULL DEFAULT false,
    published_at DOUBLE PRECISION,
    generation_complete BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ
  );
`;

async function apply(db: PGlite, ...files: string[]): Promise<void> {
  for (const file of files) {
    await db.exec(await readFile(migration(file), 'utf8'));
  }
}

/** A database at the pre-0023 rate-limit schema, ready for a legacy row to be seeded. */
async function legacyDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STAGE_META);
  await apply(db, ...PRE_RATE_LIMIT_TENANT);
  return db;
}

// Each case spins up its own PGlite; the first-run wasm load plus several
// migration replays can exceed Vitest's 5s default, so pin a generous budget.
const MIGRATION_TIMEOUT = 30_000;

describe('rate limit tenant boundary migration (0023)', () => {
  it(
    'backfills a pre-existing window into the default tenant and keeps the key usable',
    async () => {
      const db = await legacyDb();
      try {
        await db.exec(`
          INSERT INTO app_users (id, display_name) VALUES ('alice', 'A');
          INSERT INTO user_api_rate_limits
            (user_id, route_key, window_started_at, request_count)
          VALUES ('alice', 'provider_probe_models', CURRENT_TIMESTAMP, 3);
        `);

        await apply(db, RATE_LIMIT_TENANT_MIGRATION);

        const backfilled = await db.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM user_api_rate_limits WHERE user_id = 'alice'`,
        );
        expect(backfilled.rows[0]?.tenant_id).toBe('default');

        // The re-keyed primary key admits the same user/route in a second tenant,
        // which the old `(user_id, route_key)` key could not.
        await db.exec(`
          INSERT INTO user_api_rate_limits
            (tenant_id, user_id, route_key, window_started_at, request_count)
          VALUES ('acme', 'alice', 'provider_probe_models', CURRENT_TIMESTAMP, 1);
        `);
        const rows = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM user_api_rate_limits WHERE user_id = 'alice'`,
        );
        expect(rows.rows[0]?.n).toBe(2);
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );

  it(
    'keys the fixed window on the tenant once migrated',
    async () => {
      const db = await legacyDb();
      try {
        await apply(db, RATE_LIMIT_TENANT_MIGRATION);
        await db.exec(`
          INSERT INTO app_users (id, display_name) VALUES ('alice', 'A');
          INSERT INTO user_api_rate_limits
            (tenant_id, user_id, route_key, window_started_at, request_count)
          VALUES ('acme', 'alice', 'provider_probe_models', CURRENT_TIMESTAMP, 1);
        `);

        // A duplicate window in the same tenant is refused...
        await expect(
          db.exec(`
            INSERT INTO user_api_rate_limits
              (tenant_id, user_id, route_key, window_started_at, request_count)
            VALUES ('acme', 'alice', 'provider_probe_models', CURRENT_TIMESTAMP, 1);
          `),
        ).rejects.toThrow();

        // ...while a different route in the same tenant is still admitted.
        await db.exec(`
          INSERT INTO user_api_rate_limits
            (tenant_id, user_id, route_key, window_started_at, request_count)
          VALUES ('acme', 'alice', 'verify_model', CURRENT_TIMESTAMP, 1);
        `);
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );

  it(
    'is idempotent when replayed',
    async () => {
      const db = await legacyDb();
      try {
        const sql = await readFile(migration(RATE_LIMIT_TENANT_MIGRATION), 'utf8');
        await db.exec(sql);
        // PGlite returns statement results rather than undefined, so the replayed
        // migration is asserted by not throwing rather than by a resolution value.
        await db.exec(sql);
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );
});
