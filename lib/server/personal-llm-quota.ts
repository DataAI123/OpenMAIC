import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const USER_OWNER_PREFIX = 'user:';

/**
 * Controlled tenant every quota row written without an explicit tenant belongs
 * to (the single-tenant era, and the phase-1 mapping in `usage-attribution`).
 * Mirrors the `default` sentinel migration 0022 backfills existing rows with.
 */
export const DEFAULT_QUOTA_TENANT = 'default';

interface ReservationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  period_start: Date | string;
  reserved_tokens: string | number;
  status: 'reserved' | 'settled' | 'released' | 'expired';
  actual_tokens: string | number | null;
}

export interface LlmQuotaReservation {
  id: string;
  ownerId: string;
  periodStart: string;
  reservedTokens: number;
}

export class PersonalLlmQuotaExceededError extends Error {
  readonly code = 'PERSONAL_LLM_MONTHLY_QUOTA_EXCEEDED';

  constructor() {
    super('Monthly LLM token quota exceeded');
    this.name = 'PersonalLlmQuotaExceededError';
  }
}

function parseOwner(ownerId: string): string {
  if (!ownerId.startsWith(USER_OWNER_PREFIX) || ownerId.length === USER_OWNER_PREFIX.length) {
    throw new Error('PERSONAL_LLM_QUOTA_REQUIRES_AUTHENTICATED_USER');
  }
  return ownerId.slice(USER_OWNER_PREFIX.length);
}

function parseAmount(value: number, label: string, allowZero = false): bigint {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(
      `${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`,
    );
  }
  return BigInt(value);
}

function parseTenant(tenantId: string): string {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new TypeError('tenantId must be a non-empty string');
  }
  return tenantId;
}

/** UTC calendar month, matching the monthly usage log boundary. */
export function llmQuotaPeriodStart(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('PERSONAL_LLM_QUOTA_DATABASE_UNAVAILABLE');
  const { pool } = await getServerPersistenceProvider(connectionString);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Extend a live provider-step lease. */
export async function renewPersonalLlmTokenReservation(reservationId: string): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('PERSONAL_LLM_QUOTA_DATABASE_UNAVAILABLE');
  const { pool } = await getServerPersistenceProvider(connectionString);
  const updated = await pool.query(
    `UPDATE personal_usage_quota_reservations
        SET lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
      WHERE id = $1::uuid AND status = 'reserved'
      RETURNING id`,
    [reservationId],
  );
  if (updated.rowCount !== 1) throw new Error('PERSONAL_LLM_QUOTA_RESERVATION_LEASE_LOST');
}

/**
 * Atomically reserve a bounded LLM token amount. Callers must reserve an upper
 * bound before contacting a provider; a failed reservation must not proceed.
 *
 * The monthly counter is keyed by `(tenant, userId, period)`: a user who belongs
 * to two tenants draws two independent budgets. Omitting `tenantId` (a legacy
 * single-tenant caller) keeps the previous behaviour by falling back to the
 * controlled `default` tenant.
 */
export async function reservePersonalLlmTokens(
  ownerId: string,
  reserveTokens: number,
  now = new Date(),
  tenantId: string = DEFAULT_QUOTA_TENANT,
): Promise<LlmQuotaReservation> {
  const userId = parseOwner(ownerId);
  const tenant = parseTenant(tenantId);
  const amount = parseAmount(reserveTokens, 'reserveTokens');
  const periodStart = llmQuotaPeriodStart(now);
  const id = randomUUID();

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${tenant}:${userId}:${periodStart}:llm`,
    ]);
    const policy = await client.query<{ limit_amount: string | number }>(
      `SELECT limit_amount
         FROM personal_usage_quota_policies
        WHERE modality = 'llm' AND unit = 'token' AND period_kind = 'utc_calendar_month'`,
    );
    const limit = policy.rows[0]?.limit_amount;
    if (limit === undefined) throw new Error('PERSONAL_LLM_QUOTA_POLICY_UNAVAILABLE');

    await client.query(
      `INSERT INTO personal_usage_quota_months (tenant_id, user_id, period_start, limit_tokens)
       VALUES ($1, $2, $3::date, $4::bigint)
       ON CONFLICT (tenant_id, user_id, period_start) DO UPDATE
         SET limit_tokens = EXCLUDED.limit_tokens, updated_at = CURRENT_TIMESTAMP`,
      [tenant, userId, periodStart, String(limit)],
    );

    const reclaimed = await client.query<{ released_tokens: string }>(
      `WITH expired AS (
         UPDATE personal_usage_quota_reservations
            SET status = 'expired', completed_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date
            AND status = 'reserved' AND lease_expires_at <= CURRENT_TIMESTAMP
          RETURNING reserved_tokens
       )
       SELECT COALESCE(SUM(reserved_tokens), 0)::text AS released_tokens FROM expired`,
      [tenant, userId, periodStart],
    );
    const releasedTokens = BigInt(reclaimed.rows[0]?.released_tokens ?? '0');
    if (releasedTokens > BigInt(0)) {
      const reclaimedCounter = await client.query(
        `UPDATE personal_usage_quota_months
            SET reserved_tokens = reserved_tokens - $4::bigint,
                updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date
            AND reserved_tokens >= $4::bigint`,
        [tenant, userId, periodStart, releasedTokens.toString()],
      );
      if (reclaimedCounter.rowCount !== 1) {
        throw new Error('PERSONAL_LLM_QUOTA_COUNTER_INVARIANT_FAILED');
      }
    }

    const updated = await client.query(
      `UPDATE personal_usage_quota_months
          SET reserved_tokens = reserved_tokens + $4::bigint,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date
          AND used_tokens + reserved_tokens + $4::bigint <= limit_tokens
        RETURNING user_id`,
      [tenant, userId, periodStart, amount.toString()],
    );
    if (updated.rowCount !== 1) throw new PersonalLlmQuotaExceededError();

    await client.query(
      `INSERT INTO personal_usage_quota_reservations
         (id, tenant_id, user_id, period_start, reserved_tokens)
       VALUES ($1::uuid, $2, $3, $4::date, $5::bigint)`,
      [id, tenant, userId, periodStart, amount.toString()],
    );
    return { id, ownerId, periodStart, reservedTokens: reserveTokens };
  });
}

/** Commit provider-reported usage. Retries are safe when the amount is identical. */
export async function settlePersonalLlmTokens(
  reservationId: string,
  actualTokens: number,
): Promise<void> {
  const actual = parseAmount(actualTokens, 'actualTokens', true);
  await withTransaction(async (client) => {
    const result = await client.query<ReservationRow>(
      `SELECT id, tenant_id, user_id, period_start, reserved_tokens, status, actual_tokens
         FROM personal_usage_quota_reservations
        WHERE id = $1::uuid FOR UPDATE`,
      [reservationId],
    );
    const reservation = result.rows[0];
    if (!reservation) throw new Error('PERSONAL_LLM_QUOTA_RESERVATION_NOT_FOUND');
    if (reservation.status === 'settled') {
      if (BigInt(reservation.actual_tokens!) !== actual) {
        throw new Error('PERSONAL_LLM_QUOTA_RESERVATION_ALREADY_SETTLED');
      }
      return;
    }
    if (reservation.status !== 'reserved' && reservation.status !== 'expired') {
      throw new Error('PERSONAL_LLM_QUOTA_RESERVATION_NOT_ACTIVE');
    }
    const reserved = BigInt(reservation.reserved_tokens);

    // Provider-reported usage is authoritative even if an integration supplied
    // an insufficient reservation. Record the full charge; the next reservation
    // will fail while used_tokens is at or above the configured limit.
    const counterUpdate =
      reservation.status === 'reserved'
        ? await client.query(
            `UPDATE personal_usage_quota_months
                SET reserved_tokens = reserved_tokens - $4::bigint,
                    used_tokens = used_tokens + $5::bigint,
                    updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date
                AND reserved_tokens >= $4::bigint`,
            [
              reservation.tenant_id,
              reservation.user_id,
              reservation.period_start,
              reserved.toString(),
              actual.toString(),
            ],
          )
        : await client.query(
            `UPDATE personal_usage_quota_months
                SET used_tokens = used_tokens + $4::bigint,
                    updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date`,
            [
              reservation.tenant_id,
              reservation.user_id,
              reservation.period_start,
              actual.toString(),
            ],
          );
    if (counterUpdate.rowCount !== 1)
      throw new Error('PERSONAL_LLM_QUOTA_COUNTER_INVARIANT_FAILED');
    await client.query(
      `UPDATE personal_usage_quota_reservations
          SET status = 'settled', actual_tokens = $2::bigint,
              completed_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid`,
      [reservationId, actual.toString()],
    );
  });
}

/** Release reserved capacity after a provider call fails before billable usage. */
export async function releasePersonalLlmTokens(reservationId: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<ReservationRow>(
      `SELECT id, tenant_id, user_id, period_start, reserved_tokens, status, actual_tokens
         FROM personal_usage_quota_reservations
        WHERE id = $1::uuid FOR UPDATE`,
      [reservationId],
    );
    const reservation = result.rows[0];
    if (!reservation) throw new Error('PERSONAL_LLM_QUOTA_RESERVATION_NOT_FOUND');
    if (reservation.status === 'released' || reservation.status === 'expired') return;
    if (reservation.status !== 'reserved') {
      throw new Error('PERSONAL_LLM_QUOTA_RESERVATION_NOT_ACTIVE');
    }
    const reserved = BigInt(reservation.reserved_tokens);
    const counterUpdate = await client.query(
      `UPDATE personal_usage_quota_months
          SET reserved_tokens = reserved_tokens - $4::bigint,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date
          AND reserved_tokens >= $4::bigint`,
      [reservation.tenant_id, reservation.user_id, reservation.period_start, reserved.toString()],
    );
    if (counterUpdate.rowCount !== 1)
      throw new Error('PERSONAL_LLM_QUOTA_COUNTER_INVARIANT_FAILED');
    await client.query(
      `UPDATE personal_usage_quota_reservations
          SET status = 'released', completed_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid`,
      [reservationId],
    );
  });
}
