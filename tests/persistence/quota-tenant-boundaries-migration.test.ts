import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = (file: string) => path.join(process.cwd(), 'migrations', file);

const PRE_QUOTA_TENANT = ['0001_enterprise_identity.sql'];
const QUOTA_TABLES = ['0002_personal_llm_monthly_quota.sql', '0006_personal_media_quota.sql'];
const QUOTA_TENANT_MIGRATION = '0022_quota_tenant_boundaries.sql';

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

/** A database at the pre-0022 quota schema, ready for a legacy row to be seeded. */
async function legacyDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STAGE_META);
  await apply(db, ...PRE_QUOTA_TENANT, ...QUOTA_TABLES);
  return db;
}

// Each case spins up its own PGlite; the first-run wasm load plus several
// migration replays can exceed Vitest's 5s default, so pin a generous budget.
const MIGRATION_TIMEOUT = 30_000;

describe('quota tenant boundaries migration (0022)', () => {
  it(
    'backfills pre-existing counters into the default tenant and keeps the key usable',
    async () => {
      const db = await legacyDb();
      try {
        await db.exec(`
          INSERT INTO app_users (id, display_name) VALUES ('alice', 'A');
          INSERT INTO personal_usage_quota_months
            (user_id, period_start, limit_tokens, used_tokens, reserved_tokens)
          VALUES ('alice', '2026-09-01', 1000, 10, 0);
          INSERT INTO personal_media_quota_months
            (user_id, period_start, modality, limit_amount, used_amount, reserved_amount)
          VALUES ('alice', '2026-09-01', 'image', 2000, 5, 0);
        `);

        await apply(db, QUOTA_TENANT_MIGRATION);

        const llm = await db.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM personal_usage_quota_months WHERE user_id = 'alice'`,
        );
        expect(llm.rows[0]?.tenant_id).toBe('default');

        const media = await db.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM personal_media_quota_months WHERE user_id = 'alice'`,
        );
        expect(media.rows[0]?.tenant_id).toBe('default');

        // The re-keyed primary key admits the same user/month in a second tenant.
        await db.exec(`
          INSERT INTO personal_usage_quota_months
            (tenant_id, user_id, period_start, limit_tokens, used_tokens, reserved_tokens)
          VALUES ('acme', 'alice', '2026-09-01', 1000, 0, 0);
          INSERT INTO personal_media_quota_months
            (tenant_id, user_id, period_start, modality, limit_amount, used_amount, reserved_amount)
          VALUES ('acme', 'alice', '2026-09-01', 'image', 2000, 0, 0);
        `);
        const llmRows = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM personal_usage_quota_months WHERE user_id = 'alice'`,
        );
        expect(llmRows.rows[0]?.n).toBe(2);
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );

  it(
    'enforces the tenant-inclusive parent foreign key on reservations',
    async () => {
      const db = await legacyDb();
      try {
        await apply(db, QUOTA_TENANT_MIGRATION);
        await db.exec(`
          INSERT INTO app_users (id, display_name) VALUES ('alice', 'A');
          INSERT INTO personal_media_quota_months
            (tenant_id, user_id, period_start, modality, limit_amount)
          VALUES ('acme', 'alice', '2026-09-01', 'image', 2000);
        `);

        // A reservation whose tenant has no matching month row is refused, even
        // though the same (user, period, modality) exists in another tenant.
        await expect(
          db.exec(`
            INSERT INTO personal_media_quota_reservations
              (id, tenant_id, user_id, period_start, modality, reserved_amount, status)
            VALUES (gen_random_uuid(), 'other', 'alice', '2026-09-01', 'image', 1, 'reserved')
          `),
        ).rejects.toThrow();

        await db.exec(`
          INSERT INTO personal_media_quota_reservations
            (id, tenant_id, user_id, period_start, modality, reserved_amount, status)
          VALUES (gen_random_uuid(), 'acme', 'alice', '2026-09-01', 'image', 1, 'reserved')
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
        const sql = await readFile(migration(QUOTA_TENANT_MIGRATION), 'utf8');
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
