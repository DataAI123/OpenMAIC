/**
 * Database-backed contract tests for the personal LLM token quota engine.
 *
 * `personal-llm-quota.test.ts` covers only the pure input guards. This suite runs
 * the real reserve/settle/release queries against a PGlite Postgres with
 * migrations 0001 + 0002 + 0006 + 0022 applied, so the tenant-keyed monthly
 * counter, the guarded `rowCount === 1` updates and the per-tenant budget
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
    const isSelect = /^\s*(select|with)\b/i.test(sql);
    return {
      rows: res.rows,
      rowCount: isSelect ? res.rows.length : (res.affectedRows ?? res.rows.length),
    };
  };
  const pool = {
    query: (sql: string, params?: unknown[]) => normalize(sql, params),
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => normalize(sql, params),
      release: () => {},
    }),
    end: async () => {},
  };
  return { getServerPersistenceProvider: async () => ({ pool }) };
});

const USER_ID = 'llm-quota-user';
const OWNER_ID = `user:${USER_ID}`;
const NOW = new Date('2026-09-15T12:00:00Z');
const PERIOD = '2026-09-01';
// Migration 0002 seeds the single-tenant monthly allowance.
const LIMIT = 1_000_000_000;

async function tokens(tenant: string) {
  const { rows } = await state.db.query<{ used_tokens: string; reserved_tokens: string }>(
    `SELECT used_tokens::text AS used_tokens, reserved_tokens::text AS reserved_tokens
       FROM personal_usage_quota_months
      WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date`,
    [tenant, USER_ID, PERIOD],
  );
  return rows[0];
}

let reserve: typeof import('@/lib/server/personal-llm-quota').reservePersonalLlmTokens;
let settle: typeof import('@/lib/server/personal-llm-quota').settlePersonalLlmTokens;
let release: typeof import('@/lib/server/personal-llm-quota').releasePersonalLlmTokens;
let ExceededError: typeof import('@/lib/server/personal-llm-quota').PersonalLlmQuotaExceededError;

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
    '0002_personal_llm_monthly_quota.sql',
    // 0022 re-keys both quota families, so the media tables must exist too.
    '0006_personal_media_quota.sql',
    '0022_quota_tenant_boundaries.sql',
  ]) {
    await state.db.exec(await readFile(path.join(process.cwd(), 'migrations', file), 'utf8'));
  }

  const engine = await import('@/lib/server/personal-llm-quota');
  reserve = engine.reservePersonalLlmTokens;
  settle = engine.settlePersonalLlmTokens;
  release = engine.releasePersonalLlmTokens;
  ExceededError = engine.PersonalLlmQuotaExceededError;
});

afterAll(async () => {
  await state.db?.close();
  delete process.env.DATABASE_URL;
});

beforeEach(async () => {
  await state.db.exec('TRUNCATE personal_usage_quota_reservations, personal_usage_quota_months');
  await state.db.exec(
    `INSERT INTO app_users (id, display_name) VALUES ('${USER_ID}', 'Q') ON CONFLICT DO NOTHING`,
  );
});

describe('personal LLM quota engine (real SQL)', () => {
  it('falls back to the default tenant when no tenant is supplied', async () => {
    const res = await reserve(OWNER_ID, 100, NOW);
    expect(res).toMatchObject({ ownerId: OWNER_ID, periodStart: PERIOD });
    expect(await tokens('default')).toEqual({ used_tokens: '0', reserved_tokens: '100' });

    await settle(res.id, 100);
    expect(await tokens('default')).toEqual({ used_tokens: '100', reserved_tokens: '0' });
  });

  it('keeps two tenants of the same user on independent monthly budgets', async () => {
    const a = await reserve(OWNER_ID, 600_000_000, NOW, 'tenant-a');
    const b = await reserve(OWNER_ID, 600_000_000, NOW, 'tenant-b');
    expect(a.reservedTokens).toBe(600_000_000);
    expect(b.reservedTokens).toBe(600_000_000);
    expect(await tokens('tenant-a')).toEqual({
      used_tokens: '0',
      reserved_tokens: '600000000',
    });
    expect(await tokens('tenant-b')).toEqual({
      used_tokens: '0',
      reserved_tokens: '600000000',
    });

    // The limit is per tenant: tenant-a is over (600M + 500M > 1B) while
    // tenant-b keeps its own independent budget (600M + 400M = 1B).
    await expect(reserve(OWNER_ID, 500_000_000, NOW, 'tenant-a')).rejects.toBeInstanceOf(
      ExceededError,
    );
    // tenant-a's rejected reservation left its own counter untouched...
    expect(await tokens('tenant-a')).toEqual({
      used_tokens: '0',
      reserved_tokens: '600000000',
    });
    // ...and did not touch tenant-b's independent budget.
    const c = await reserve(OWNER_ID, 400_000_000, NOW, 'tenant-b');
    expect(c.reservedTokens).toBe(400_000_000);
    expect(await tokens('tenant-b')).toEqual({
      used_tokens: '0',
      reserved_tokens: '1000000000',
    });
  });

  it('settles and releases against the reservation tenant only', async () => {
    const a = await reserve(OWNER_ID, 1000, NOW, 'tenant-a');
    const b = await reserve(OWNER_ID, 1000, NOW, 'tenant-b');

    await settle(a.id, 400);
    expect(await tokens('tenant-a')).toEqual({ used_tokens: '400', reserved_tokens: '0' });
    // tenant-b's counter is untouched by tenant-a's settlement.
    expect(await tokens('tenant-b')).toEqual({ used_tokens: '0', reserved_tokens: '1000' });

    await release(b.id);
    expect(await tokens('tenant-b')).toEqual({ used_tokens: '0', reserved_tokens: '0' });
  });

  it('rejects a reservation once the per-tenant limit would be crossed', async () => {
    await reserve(OWNER_ID, LIMIT - 1, NOW, 'tenant-a');
    await expect(reserve(OWNER_ID, 10, NOW, 'tenant-a')).rejects.toBeInstanceOf(ExceededError);
    // The failed reserve left the counter untouched.
    expect(await tokens('tenant-a')).toEqual({
      used_tokens: '0',
      reserved_tokens: String(LIMIT - 1),
    });
  });
});
