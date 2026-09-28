/**
 * Database-backed contract tests for the personal media quota engine.
 *
 * `personal-modality-quota.test.ts` covers the pure input guards (owner shape,
 * modality, amount) and `generate-routes-quota.test.ts` drives the routes with
 * the engine mocked. Neither exercises the real SQL state machine. This suite
 * runs the actual reserve/settle/release/reclaim queries against a PGlite
 * Postgres with migrations 0001 + 0002 + 0006 + 0022 applied, so the
 * advisory-lock reserve, the `rowCount === 1` "did the guarded UPDATE match?"
 * checks, the expired-lease reclaim, the `actual > reserved` full-charge and the
 * idempotent-settle behaviour are all verified for real rather than mocked away.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine reaches Postgres through getServerPersistenceProvider; the mock
// resolves it to the PGlite instance held here (set in beforeAll). A single
// PGlite connection runs every reserve/settle call sequentially, which is
// exactly what these state-machine assertions need.
const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('@/lib/persistence/server-provider', () => {
  const normalize = async (sql: string, params?: unknown[]) => {
    const res = await state.db.query(sql, (params ?? []) as never[]);
    const isSelect = /^\s*(select|with)\b/i.test(sql);
    return {
      rows: res.rows,
      // `pg` reports rowCount as returned rows for SELECTs and affected rows
      // otherwise; the engine relies on that to detect a no-op guarded UPDATE.
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

const USER_ID = 'quota-user';
const OWNER_ID = `user:${USER_ID}`;
// Fixed instant so the derived UTC month is deterministic across runs.
const NOW = new Date('2026-09-15T12:00:00Z');
const PERIOD = '2026-09-01';

async function month(modality: string) {
  const { rows } = await state.db.query<{ used_amount: string; reserved_amount: string }>(
    `SELECT used_amount::text AS used_amount, reserved_amount::text AS reserved_amount
       FROM personal_media_quota_months
      WHERE user_id = $1 AND period_start = $2::date AND modality = $3`,
    [USER_ID, PERIOD, modality],
  );
  return rows[0];
}

async function tenantMonth(tenant: string, modality: string) {
  const { rows } = await state.db.query<{ used_amount: string; reserved_amount: string }>(
    `SELECT used_amount::text AS used_amount, reserved_amount::text AS reserved_amount
       FROM personal_media_quota_months
      WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date AND modality = $4`,
    [tenant, USER_ID, PERIOD, modality],
  );
  return rows[0];
}

async function reservationStatus(id: string) {
  const { rows } = await state.db.query<{ status: string }>(
    `SELECT status FROM personal_media_quota_reservations WHERE id = $1::uuid`,
    [id],
  );
  return rows[0]?.status;
}

let reserve: typeof import('@/lib/server/personal-modality-quota').reservePersonalMediaQuota;
let settle: typeof import('@/lib/server/personal-modality-quota').settlePersonalMediaQuota;
let release: typeof import('@/lib/server/personal-modality-quota').releasePersonalMediaQuota;
let renew: typeof import('@/lib/server/personal-modality-quota').renewPersonalMediaQuotaReservation;
let ExceededError: typeof import('@/lib/server/personal-modality-quota').PersonalMediaQuotaExceededError;

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
  await state.db.exec(
    await readFile(path.join(process.cwd(), 'migrations', '0001_enterprise_identity.sql'), 'utf8'),
  );
  await state.db.exec(
    await readFile(
      path.join(process.cwd(), 'migrations', '0002_personal_llm_monthly_quota.sql'),
      'utf8',
    ),
  );
  await state.db.exec(
    await readFile(path.join(process.cwd(), 'migrations', '0006_personal_media_quota.sql'), 'utf8'),
  );
  // 0022 re-keys both quota families, so the LLM tables must exist too.
  await state.db.exec(
    await readFile(
      path.join(process.cwd(), 'migrations', '0022_quota_tenant_boundaries.sql'),
      'utf8',
    ),
  );

  const engine = await import('@/lib/server/personal-modality-quota');
  reserve = engine.reservePersonalMediaQuota;
  settle = engine.settlePersonalMediaQuota;
  release = engine.releasePersonalMediaQuota;
  renew = engine.renewPersonalMediaQuotaReservation;
  ExceededError = engine.PersonalMediaQuotaExceededError;
});

afterAll(async () => {
  await state.db?.close();
  delete process.env.DATABASE_URL;
});

beforeEach(async () => {
  await state.db.exec('TRUNCATE personal_media_quota_reservations, personal_media_quota_months');
  await state.db.exec(
    `INSERT INTO app_users (id, display_name) VALUES ('${USER_ID}', 'Q') ON CONFLICT DO NOTHING`,
  );
});

describe('personal media quota engine (real SQL)', () => {
  it('reserve→settle moves the amount from reserved to used', async () => {
    const res = await reserve(OWNER_ID, 'image', 1, NOW);
    expect(res).toMatchObject({ ownerId: OWNER_ID, modality: 'image', periodStart: PERIOD });
    expect(await month('image')).toEqual({ used_amount: '0', reserved_amount: '1' });

    await settle(res.id, 1);
    expect(await month('image')).toEqual({ used_amount: '1', reserved_amount: '0' });
    expect(await reservationStatus(res.id)).toBe('settled');
  });

  it('settles the full provider-reported amount even when it exceeds the reservation', async () => {
    const res = await reserve(OWNER_ID, 'video', 1, NOW);
    await settle(res.id, 5);
    // reserved counter drops by the reservation, used rises by the actual charge.
    expect(await month('video')).toEqual({ used_amount: '5', reserved_amount: '0' });
  });

  it('throws the exceeded error and reserves nothing once the limit is crossed', async () => {
    const res = await reserve(OWNER_ID, 'image', 1500, NOW);
    expect(await month('image')).toEqual({ used_amount: '0', reserved_amount: '1500' });

    await expect(reserve(OWNER_ID, 'image', 600, NOW)).rejects.toBeInstanceOf(ExceededError);
    // The failed reserve left the counter untouched.
    expect(await month('image')).toEqual({ used_amount: '0', reserved_amount: '1500' });
    expect(res.reservedAmount).toBe(1500);
  });

  it('releases reserved capacity back to the counter', async () => {
    const res = await reserve(OWNER_ID, 'tts', 200, NOW);
    expect(await month('tts')).toEqual({ used_amount: '0', reserved_amount: '200' });

    await release(res.id);
    expect(await month('tts')).toEqual({ used_amount: '0', reserved_amount: '0' });
    expect(await reservationStatus(res.id)).toBe('released');
  });

  it('settling twice with the same amount is idempotent, a differing amount is rejected', async () => {
    const res = await reserve(OWNER_ID, 'image', 3, NOW);
    await settle(res.id, 3);
    await settle(res.id, 3);
    expect(await month('image')).toEqual({ used_amount: '3', reserved_amount: '0' });

    await expect(settle(res.id, 4)).rejects.toThrow(/ALREADY_SETTLED/);
    expect(await month('image')).toEqual({ used_amount: '3', reserved_amount: '0' });
  });

  it('reclaims an expired lease into the reserve budget on the next attempt', async () => {
    const stale = await reserve(OWNER_ID, 'image', 1800, NOW);
    expect(await month('image')).toEqual({ used_amount: '0', reserved_amount: '1800' });

    // Age the lease into the past so the next reserve treats it as abandoned.
    await state.db.exec(
      `UPDATE personal_media_quota_reservations
          SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour'
        WHERE id = '${stale.id}'::uuid`,
    );

    // 1800 stale + 500 new would breach the 2000 limit, but the reclaim frees
    // the expired reservation first so the 500 reserve succeeds.
    const fresh = await reserve(OWNER_ID, 'image', 500, NOW);
    expect(await reservationStatus(stale.id)).toBe('expired');
    expect(await month('image')).toEqual({ used_amount: '0', reserved_amount: '500' });
    expect(fresh.reservedAmount).toBe(500);
  });

  it('renews a live reservation lease and rejects a lease that is no longer reserved', async () => {
    const res = await reserve(OWNER_ID, 'image', 1, NOW);
    // Extending a still-open reservation succeeds without touching counters.
    await renew(res.id);
    expect(await month('image')).toEqual({ used_amount: '0', reserved_amount: '1' });

    // Once settled the lease no longer exists, so a renewal must fail loudly.
    await settle(res.id, 1);
    await expect(renew(res.id)).rejects.toThrow(/LEASE_LOST/);
    // A missing reservation id is likewise a lost lease, never a silent success.
    await expect(renew('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/LEASE_LOST/);
  });

  it('keeps two tenants of the same user on independent monthly budgets', async () => {
    // The 2000-image limit is per (tenant, user): 1500 in tenant-a and 1500 in
    // tenant-b both succeed, where a shared budget would refuse the second.
    const a = await reserve(OWNER_ID, 'image', 1500, NOW, 'tenant-a');
    const b = await reserve(OWNER_ID, 'image', 1500, NOW, 'tenant-b');
    expect(a.reservedAmount).toBe(1500);
    expect(b.reservedAmount).toBe(1500);
    expect(await tenantMonth('tenant-a', 'image')).toEqual({
      used_amount: '0',
      reserved_amount: '1500',
    });
    expect(await tenantMonth('tenant-b', 'image')).toEqual({
      used_amount: '0',
      reserved_amount: '1500',
    });

    // tenant-a is full (1500 + 600 > 2000) while tenant-b still has room.
    await expect(reserve(OWNER_ID, 'image', 600, NOW, 'tenant-a')).rejects.toBeInstanceOf(
      ExceededError,
    );
    const c = await reserve(OWNER_ID, 'image', 100, NOW, 'tenant-b');
    expect(c.reservedAmount).toBe(100);
    expect(await tenantMonth('tenant-b', 'image')).toEqual({
      used_amount: '0',
      reserved_amount: '1600',
    });
  });

  it('settles against the reservation tenant even when another tenant shares the user', async () => {
    const a = await reserve(OWNER_ID, 'tts', 100, NOW, 'tenant-a');
    const b = await reserve(OWNER_ID, 'tts', 100, NOW, 'tenant-b');

    await settle(a.id, 40);
    expect(await tenantMonth('tenant-a', 'tts')).toEqual({
      used_amount: '40',
      reserved_amount: '0',
    });
    // tenant-b's counter is untouched by tenant-a's settlement.
    expect(await tenantMonth('tenant-b', 'tts')).toEqual({
      used_amount: '0',
      reserved_amount: '100',
    });

    await release(b.id);
    expect(await tenantMonth('tenant-b', 'tts')).toEqual({
      used_amount: '0',
      reserved_amount: '0',
    });
  });
});
