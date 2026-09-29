/**
 * Database-backed contract tests for the tenant-keyed rate-limit windows.
 *
 * `user-api-rate-limit.test.ts` locks the mocked SQL shape (`[tenant, user,
 * route, limit]`) and the legacy/default fallback. This suite runs the real
 * upsert against a PGlite Postgres with migrations 0001 + 0003 + 0010 + 0023
 * applied, so the tenant-inclusive conflict target and the per-tenant window
 * separation are verified for real rather than mocked away.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('@/lib/persistence/server-provider', () => {
  const normalize = async (sql: string, params?: unknown[]) => {
    const res = await state.db.query(sql, (params ?? []) as never[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  };
  const pool = { query: (sql: string, params?: unknown[]) => normalize(sql, params) };
  return { getServerPersistenceProvider: async () => ({ pool }) };
});

const USER_ID = 'rl-user';
const OWNER_ID = `user:${USER_ID}`;

async function windows(tenant: string) {
  const { rows } = await state.db.query<{ route_key: string; request_count: number }>(
    `SELECT route_key, request_count::int AS request_count
       FROM user_api_rate_limits
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY route_key`,
    [tenant, USER_ID],
  );
  return rows;
}

let consume: typeof import('@/lib/server/user-api-rate-limit').consumeActionRateLimit;
let runWithAttribution: typeof import('@/lib/server/usage-attribution').runWithUsageAttribution;
let ExceededError: typeof import('@/lib/server/user-api-rate-limit').UserApiRateLimitExceededError;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://bridge/not-used';
  state.db = new PGlite();
  await state.db.exec(`
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
    '0010_action_rate_limits.sql',
    '0023_rate_limit_tenant_boundary.sql',
  ]) {
    await state.db.exec(await readFile(path.join(process.cwd(), 'migrations', file), 'utf8'));
  }

  const engine = await import('@/lib/server/user-api-rate-limit');
  consume = engine.consumeActionRateLimit;
  ExceededError = engine.UserApiRateLimitExceededError;
  runWithAttribution = (await import('@/lib/server/usage-attribution')).runWithUsageAttribution;
});

afterAll(async () => {
  await state.db?.close();
  delete process.env.DATABASE_URL;
});

beforeEach(async () => {
  await state.db.exec('TRUNCATE user_api_rate_limits');
  await state.db.exec(
    `INSERT INTO app_users (id, display_name) VALUES ('${USER_ID}', 'R') ON CONFLICT DO NOTHING`,
  );
});

describe('rate limit windows (real SQL)', () => {
  it('falls back to the default tenant when no attribution is present', async () => {
    await consume(OWNER_ID, 'api_chat', 1);
    await expect(consume(OWNER_ID, 'api_chat', 1)).rejects.toBeInstanceOf(ExceededError);

    // The rejected admission left the window at its admitted count.
    expect(await windows('default')).toEqual([{ route_key: 'api_chat', request_count: 1 }]);
  });

  it('keeps two tenants of the same user on independent windows', async () => {
    const inTenant = (tenantId: string) =>
      runWithAttribution({ ownerId: OWNER_ID, tenantId }, () => consume(OWNER_ID, 'api_chat', 2));

    await inTenant('tenant-a');
    await inTenant('tenant-a');

    // tenant-a is now saturated, but tenant-b's window is its own.
    await expect(inTenant('tenant-a')).rejects.toBeInstanceOf(ExceededError);
    await inTenant('tenant-b');

    expect(await windows('tenant-a')).toEqual([{ route_key: 'api_chat', request_count: 2 }]);
    expect(await windows('tenant-b')).toEqual([{ route_key: 'api_chat', request_count: 1 }]);
  });

  it('keeps a tenant window separate from the unattributed default window', async () => {
    await runWithAttribution({ ownerId: OWNER_ID, tenantId: 'tenant-a' }, () =>
      consume(OWNER_ID, 'api_chat', 1),
    );
    await consume(OWNER_ID, 'api_chat', 1);

    expect(await windows('tenant-a')).toEqual([{ route_key: 'api_chat', request_count: 1 }]);
    expect(await windows('default')).toEqual([{ route_key: 'api_chat', request_count: 1 }]);
  });
});
