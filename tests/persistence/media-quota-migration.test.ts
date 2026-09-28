import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const identityMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0001_enterprise_identity.sql',
);
const mediaQuotaMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0006_personal_media_quota.sql',
);

async function migratedDb(): Promise<PGlite> {
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
  await db.exec(await readFile(mediaQuotaMigrationPath, 'utf8'));
  return db;
}

// Each case spins up its own PGlite and applies the full 0001 + 0006 migrations
// to keep inserted rows isolated; first-run wasm load plus migration apply can
// exceed Vitest's 5s default, so pin a generous per-test budget.
const MIGRATION_TIMEOUT = 30_000;

describe('personal media quota migration (0006)', () => {
  it(
    'seeds the confirmed balanced-pilot limits for image/video/tts',
    async () => {
      const db = await migratedDb();
      try {
        const rows = await db.query<{ modality: string; unit: string; limit_amount: string }>(
          'SELECT modality, unit, limit_amount::text AS limit_amount FROM personal_media_quota_policies ORDER BY modality',
        );
        expect(rows.rows).toEqual([
          { modality: 'image', unit: 'image', limit_amount: '2000' },
          { modality: 'tts', unit: 'character', limit_amount: '2000000' },
          { modality: 'video', unit: 'second', limit_amount: '3600' },
        ]);
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );

  it(
    'restricts policy and month modalities to the reviewed set',
    async () => {
      const db = await migratedDb();
      try {
        await expect(
          db.exec(`
            INSERT INTO personal_media_quota_policies (modality, unit, period_kind, limit_amount)
            VALUES ('asr', 'second', 'utc_calendar_month', 100)
          `),
        ).rejects.toThrow();

        await db.exec(`INSERT INTO app_users (id, display_name) VALUES ('media-user', 'M')`);
        await expect(
          db.exec(`
            INSERT INTO personal_media_quota_months (user_id, period_start, modality, limit_amount)
            VALUES ('media-user', '2026-09-01', 'llm', 100)
          `),
        ).rejects.toThrow();
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );

  it(
    'enforces reservation status/amount and parent invariants',
    async () => {
      const db = await migratedDb();
      try {
        await db.exec(`INSERT INTO app_users (id, display_name) VALUES ('media-user', 'M')`);
        await db.exec(`
          INSERT INTO personal_media_quota_months
            (user_id, period_start, modality, limit_amount, used_amount, reserved_amount)
          VALUES ('media-user', '2026-09-01', 'image', 2000, 0, 0)
        `);

        // A settled reservation must carry an actual amount.
        await expect(
          db.exec(`
            INSERT INTO personal_media_quota_reservations
              (id, user_id, period_start, modality, reserved_amount, status, actual_amount, completed_at)
            VALUES (gen_random_uuid(), 'media-user', '2026-09-01', 'image', 1, 'settled', NULL, CURRENT_TIMESTAMP)
          `),
        ).rejects.toThrow();

        // A reserved (open) reservation must not carry completed_at.
        await expect(
          db.exec(`
            INSERT INTO personal_media_quota_reservations
              (id, user_id, period_start, modality, reserved_amount, status, completed_at)
            VALUES (gen_random_uuid(), 'media-user', '2026-09-01', 'image', 1, 'reserved', CURRENT_TIMESTAMP)
          `),
        ).rejects.toThrow();

        // reserved_amount must be strictly positive.
        await expect(
          db.exec(`
            INSERT INTO personal_media_quota_reservations
              (id, user_id, period_start, modality, reserved_amount, status)
            VALUES (gen_random_uuid(), 'media-user', '2026-09-01', 'image', 0, 'reserved')
          `),
        ).rejects.toThrow();

        // A reservation for an unseeded month row is rejected by the FK.
        await expect(
          db.exec(`
            INSERT INTO personal_media_quota_reservations
              (id, user_id, period_start, modality, reserved_amount, status)
            VALUES (gen_random_uuid(), 'media-user', '2026-10-01', 'video', 1, 'reserved')
          `),
        ).rejects.toThrow();

        // A well-formed open reservation succeeds.
        await db.exec(`
          INSERT INTO personal_media_quota_reservations
            (id, user_id, period_start, modality, reserved_amount, status)
          VALUES (gen_random_uuid(), 'media-user', '2026-09-01', 'image', 1, 'reserved')
        `);
        const open = await db.query(
          `SELECT count(*)::int AS n FROM personal_media_quota_reservations
            WHERE user_id = 'media-user' AND status = 'reserved'`,
        );
        expect(open.rows[0]).toEqual({ n: 1 });
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );
});
