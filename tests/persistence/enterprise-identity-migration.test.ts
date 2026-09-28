import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(process.cwd(), 'migrations', '0001_enterprise_identity.sql');
const quotaMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0002_personal_llm_monthly_quota.sql',
);
const apiRateLimitMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0003_user_api_rate_limits.sql',
);
const azureVoicesRateLimitMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0004_azure_voices_rate_limit.sql',
);
const pdfProviderVerifyRateLimitMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0005_pdf_provider_verify_rate_limit.sql',
);
const imageProviderVerifyRateLimitMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0007_verify_image_provider_rate_limit.sql',
);
const videoProviderVerifyRateLimitMigrationPath = path.join(
  process.cwd(),
  'migrations',
  '0008_verify_video_provider_rate_limit.sql',
);

describe('enterprise identity schema migration', () => {
  it('adds identity and tenant tables and assigns existing resources to the default tenant', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE stage_meta (
          stage_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          is_public BOOLEAN NOT NULL DEFAULT false,
          published_at DOUBLE PRECISION,
          generation_complete BOOLEAN NOT NULL DEFAULT false,
          deleted_at TIMESTAMPTZ
        );
        INSERT INTO stage_meta (stage_id, owner_id) VALUES ('existing-stage', 'anon:legacy');
      `);
      await db.exec(await readFile(migrationPath, 'utf8'));

      const resources = await db.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM stage_meta WHERE stage_id = $1',
        ['existing-stage'],
      );
      expect(resources.rows).toEqual([{ tenant_id: 'default' }]);

      await db.exec(`
        INSERT INTO app_users (id, display_name) VALUES ('user-1', 'A');
        INSERT INTO external_identities (id, user_id, issuer, subject)
        VALUES ('identity-1', 'user-1', 'https://id.example/realm', 'subject-1');
        INSERT INTO tenant_memberships (tenant_id, user_id, role)
        VALUES ('default', 'user-1', 'owner');
      `);
      await expect(
        db.exec(`
          INSERT INTO external_identities (id, user_id, issuer, subject)
          VALUES ('identity-2', 'user-1', 'https://id.example/realm', 'subject-1')
        `),
      ).rejects.toThrow();
      await expect(
        db.exec(`
          INSERT INTO tenant_memberships (tenant_id, user_id, role)
          VALUES ('default', 'user-1', 'superuser')
        `),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('adds bounded per-user API rate-limit storage with user deletion cleanup', async () => {
    const db = new PGlite();
    try {
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
      await db.exec(await readFile(migrationPath, 'utf8'));
      await db.exec(await readFile(quotaMigrationPath, 'utf8'));
      await db.exec(await readFile(apiRateLimitMigrationPath, 'utf8'));
      await db.exec(await readFile(azureVoicesRateLimitMigrationPath, 'utf8'));
      await db.exec(await readFile(pdfProviderVerifyRateLimitMigrationPath, 'utf8'));
      await db.exec(await readFile(imageProviderVerifyRateLimitMigrationPath, 'utf8'));
      await db.exec(await readFile(videoProviderVerifyRateLimitMigrationPath, 'utf8'));
      await db.exec(`
        INSERT INTO app_users (id) VALUES ('rate-user');
        INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
        VALUES ('rate-user', 'provider_probe_models', CURRENT_TIMESTAMP, 1);
        INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
        VALUES ('rate-user', 'verify_model', CURRENT_TIMESTAMP, 1);
        INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
        VALUES ('rate-user', 'azure_voices', CURRENT_TIMESTAMP, 1);
        INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
        VALUES ('rate-user', 'verify_pdf_provider', CURRENT_TIMESTAMP, 1);
        INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
        VALUES ('rate-user', 'verify_image_provider', CURRENT_TIMESTAMP, 1);
        INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
        VALUES ('rate-user', 'verify_video_provider', CURRENT_TIMESTAMP, 1);
      `);
      await expect(
        db.exec(`
          INSERT INTO user_api_rate_limits (user_id, route_key, window_started_at, request_count)
          VALUES ('rate-user', 'unreviewed-route', CURRENT_TIMESTAMP, 1)
        `),
      ).rejects.toThrow();
      await db.exec(`DELETE FROM app_users WHERE id = 'rate-user'`);
      const remaining = await db.query('SELECT * FROM user_api_rate_limits');
      expect(remaining.rows).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
