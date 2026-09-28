import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

// Migration 0010 extends the user_api_rate_limits route-key CHECK for the
// stateless action routes; 0011 -> 0016 keep widening it for each accepted
// batch. Applied over the real 0001 -> 0003 -> 0008 chain on PGlite so the
// constraint drop/re-add sequence is verified against the same SQL production
// migrations run, including that every previously whitelisted key survives the
// widening.

const ACTION_KEYS = [
  'api_chat',
  'chat_pi',
  'generate_scene_content',
  'generate_scene_actions',
  'generate_scene_outlines_stream',
  'generate_agent_profiles',
  'generate_voice',
  'quiz_grade',
  'pbl_v2_instructor',
  'pbl_v2_evaluate',
  'pbl_v2_open_task',
  'pbl_v2_simulator',
  'pbl_v2_task_update',
  'extract_document',
  'transcription',
  'parse_pdf',
  'proxy_media',
  'classroom_store',
  'generate_classroom',
  'web_search',
];
const LEGACY_KEYS = [
  'provider_probe_models',
  'verify_model',
  'azure_voices',
  'verify_pdf_provider',
  'verify_image_provider',
  'verify_video_provider',
];

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
  for (const file of [
    '0001_enterprise_identity.sql',
    '0003_user_api_rate_limits.sql',
    '0008_verify_video_provider_rate_limit.sql',
    '0010_action_rate_limits.sql',
    '0011_extract_transcription_rate_limits.sql',
    '0012_classroom_rate_limits.sql',
    '0013_web_search_rate_limit.sql',
    '0014_parse_pdf_rate_limit.sql',
    '0015_proxy_media_rate_limit.sql',
    '0016_chat_pi_rate_limit.sql',
  ]) {
    await db.exec(await readFile(path.join(process.cwd(), 'migrations', file), 'utf8'));
  }
  await db.exec(`INSERT INTO app_users (id, display_name) VALUES ('rl-user', 'R')`);
  return db;
}

// PGlite wasm boot plus the full migration chain per case; the first run can
// exceed Vitest's 5s default.
const MIGRATION_TIMEOUT = 30_000;

describe('action rate limit route keys (migrations 0010 + 0011 + 0012 + 0013 + 0014 + 0015 + 0016)', () => {
  it(
    'admits every widened action key alongside the six legacy keys',
    async () => {
      const db = await migratedDb();
      try {
        for (const [index, key] of [...ACTION_KEYS, ...LEGACY_KEYS].entries()) {
          await db.exec(`
            INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
            VALUES ('rl-user', '${key}', CURRENT_TIMESTAMP, ${index + 1})
          `);
        }
        const rows = await db.query<{ route_key: string }>(
          'SELECT route_key FROM user_api_rate_limits WHERE user_id = $1',
          ['rl-user'],
        );
        expect(rows.rows.map((row) => row.route_key)).toHaveLength(26);
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );

  it(
    'still rejects route keys outside the widened whitelist',
    async () => {
      const db = await migratedDb();
      try {
        await expect(
          db.exec(`
            INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
            VALUES ('rl-user', 'some_future_route', CURRENT_TIMESTAMP, 1)
          `),
        ).rejects.toThrow();
      } finally {
        await db.close();
      }
    },
    MIGRATION_TIMEOUT,
  );
});
