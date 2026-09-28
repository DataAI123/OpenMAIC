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

/** Atomic paid media modalities covered by this quota (LLM tokens live in 0002). */
export const MEDIA_QUOTA_MODALITIES = ['image', 'video', 'tts'] as const;
export type MediaQuotaModality = (typeof MEDIA_QUOTA_MODALITIES)[number];

interface ReservationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  period_start: Date | string;
  modality: string;
  reserved_amount: string | number;
  status: 'reserved' | 'settled' | 'released' | 'expired';
  actual_amount: string | number | null;
}

export interface MediaQuotaReservation {
  id: string;
  ownerId: string;
  modality: MediaQuotaModality;
  periodStart: string;
  reservedAmount: number;
}

export class PersonalMediaQuotaExceededError extends Error {
  readonly code = 'PERSONAL_MEDIA_MONTHLY_QUOTA_EXCEEDED';

  constructor(readonly modality: MediaQuotaModality) {
    super(`Monthly ${modality} quota exceeded`);
    this.name = 'PersonalMediaQuotaExceededError';
  }
}

function parseOwner(ownerId: string): string {
  if (!ownerId.startsWith(USER_OWNER_PREFIX) || ownerId.length === USER_OWNER_PREFIX.length) {
    throw new Error('PERSONAL_MEDIA_QUOTA_REQUIRES_AUTHENTICATED_USER');
  }
  return ownerId.slice(USER_OWNER_PREFIX.length);
}

function assertModality(modality: MediaQuotaModality): void {
  if (!MEDIA_QUOTA_MODALITIES.includes(modality)) {
    throw new TypeError(`modality must be one of: ${MEDIA_QUOTA_MODALITIES.join(', ')}`);
  }
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

/** UTC calendar month, matching the LLM quota and monthly usage-log boundary. */
export function mediaQuotaPeriodStart(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('PERSONAL_MEDIA_QUOTA_DATABASE_UNAVAILABLE');
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

/** Extend a live provider-call lease (for slow endpoints such as video render). */
export async function renewPersonalMediaQuotaReservation(reservationId: string): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('PERSONAL_MEDIA_QUOTA_DATABASE_UNAVAILABLE');
  const { pool } = await getServerPersistenceProvider(connectionString);
  const updated = await pool.query(
    `UPDATE personal_media_quota_reservations
        SET lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
      WHERE id = $1::uuid AND status = 'reserved'
      RETURNING id`,
    [reservationId],
  );
  if (updated.rowCount !== 1) throw new Error('PERSONAL_MEDIA_QUOTA_RESERVATION_LEASE_LOST');
}

/**
 * Atomically reserve a bounded media quantity (images / video seconds / TTS
 * characters) for the current month. Callers must reserve an upper bound before
 * contacting a provider; a failed reservation must not proceed.
 *
 * The monthly counter is keyed by `(tenant, userId, period, modality)`: a user
 * who belongs to two tenants draws two independent budgets. Omitting `tenantId`
 * (a legacy single-tenant caller) keeps the previous behaviour by falling back
 * to the controlled `default` tenant.
 */
export async function reservePersonalMediaQuota(
  ownerId: string,
  modality: MediaQuotaModality,
  reserveAmount: number,
  now = new Date(),
  tenantId: string = DEFAULT_QUOTA_TENANT,
): Promise<MediaQuotaReservation> {
  const userId = parseOwner(ownerId);
  const tenant = parseTenant(tenantId);
  assertModality(modality);
  const amount = parseAmount(reserveAmount, 'reserveAmount');
  const periodStart = mediaQuotaPeriodStart(now);
  const id = randomUUID();

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${tenant}:${userId}:${periodStart}:media:${modality}`,
    ]);
    const policy = await client.query<{ limit_amount: string | number }>(
      `SELECT limit_amount
         FROM personal_media_quota_policies
        WHERE modality = $1 AND period_kind = 'utc_calendar_month'`,
      [modality],
    );
    const limit = policy.rows[0]?.limit_amount;
    if (limit === undefined) throw new Error('PERSONAL_MEDIA_QUOTA_POLICY_UNAVAILABLE');

    await client.query(
      `INSERT INTO personal_media_quota_months
         (tenant_id, user_id, period_start, modality, limit_amount)
       VALUES ($1, $2, $3::date, $4, $5::bigint)
       ON CONFLICT (tenant_id, user_id, period_start, modality) DO UPDATE
         SET limit_amount = EXCLUDED.limit_amount, updated_at = CURRENT_TIMESTAMP`,
      [tenant, userId, periodStart, modality, String(limit)],
    );

    const reclaimed = await client.query<{ released_amount: string }>(
      `WITH expired AS (
         UPDATE personal_media_quota_reservations
            SET status = 'expired', completed_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date AND modality = $4
            AND status = 'reserved' AND lease_expires_at <= CURRENT_TIMESTAMP
          RETURNING reserved_amount
       )
       SELECT COALESCE(SUM(reserved_amount), 0)::text AS released_amount FROM expired`,
      [tenant, userId, periodStart, modality],
    );
    const releasedAmount = BigInt(reclaimed.rows[0]?.released_amount ?? '0');
    if (releasedAmount > BigInt(0)) {
      const reclaimedCounter = await client.query(
        `UPDATE personal_media_quota_months
            SET reserved_amount = reserved_amount - $5::bigint,
                updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date AND modality = $4
            AND reserved_amount >= $5::bigint`,
        [tenant, userId, periodStart, modality, releasedAmount.toString()],
      );
      if (reclaimedCounter.rowCount !== 1) {
        throw new Error('PERSONAL_MEDIA_QUOTA_COUNTER_INVARIANT_FAILED');
      }
    }

    const updated = await client.query(
      `UPDATE personal_media_quota_months
          SET reserved_amount = reserved_amount + $5::bigint,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date AND modality = $4
          AND used_amount + reserved_amount + $5::bigint <= limit_amount
        RETURNING user_id`,
      [tenant, userId, periodStart, modality, amount.toString()],
    );
    if (updated.rowCount !== 1) throw new PersonalMediaQuotaExceededError(modality);

    await client.query(
      `INSERT INTO personal_media_quota_reservations
         (id, tenant_id, user_id, period_start, modality, reserved_amount)
       VALUES ($1::uuid, $2, $3, $4::date, $5, $6::bigint)`,
      [id, tenant, userId, periodStart, modality, amount.toString()],
    );
    return { id, ownerId, modality, periodStart, reservedAmount: reserveAmount };
  });
}

/** Commit provider-reported usage. Retries are safe when the amount is identical. */
export async function settlePersonalMediaQuota(
  reservationId: string,
  actualAmount: number,
): Promise<void> {
  const actual = parseAmount(actualAmount, 'actualAmount', true);
  await withTransaction(async (client) => {
    const result = await client.query<ReservationRow>(
      `SELECT id, tenant_id, user_id, period_start, modality, reserved_amount, status, actual_amount
         FROM personal_media_quota_reservations
        WHERE id = $1::uuid FOR UPDATE`,
      [reservationId],
    );
    const reservation = result.rows[0];
    if (!reservation) throw new Error('PERSONAL_MEDIA_QUOTA_RESERVATION_NOT_FOUND');
    if (reservation.status === 'settled') {
      if (BigInt(reservation.actual_amount!) !== actual) {
        throw new Error('PERSONAL_MEDIA_QUOTA_RESERVATION_ALREADY_SETTLED');
      }
      return;
    }
    if (reservation.status !== 'reserved' && reservation.status !== 'expired') {
      throw new Error('PERSONAL_MEDIA_QUOTA_RESERVATION_NOT_ACTIVE');
    }
    const reserved = BigInt(reservation.reserved_amount);

    // Provider-reported usage is authoritative even if an integration supplied an
    // insufficient reservation. Record the full charge; the next reservation will
    // fail while used_amount is at or above the configured limit.
    const counterUpdate =
      reservation.status === 'reserved'
        ? await client.query(
            `UPDATE personal_media_quota_months
                SET reserved_amount = reserved_amount - $5::bigint,
                    used_amount = used_amount + $6::bigint,
                    updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date AND modality = $4
                AND reserved_amount >= $5::bigint`,
            [
              reservation.tenant_id,
              reservation.user_id,
              reservation.period_start,
              reservation.modality,
              reserved.toString(),
              actual.toString(),
            ],
          )
        : await client.query(
            `UPDATE personal_media_quota_months
                SET used_amount = used_amount + $5::bigint,
                    updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date AND modality = $4`,
            [
              reservation.tenant_id,
              reservation.user_id,
              reservation.period_start,
              reservation.modality,
              actual.toString(),
            ],
          );
    if (counterUpdate.rowCount !== 1)
      throw new Error('PERSONAL_MEDIA_QUOTA_COUNTER_INVARIANT_FAILED');
    await client.query(
      `UPDATE personal_media_quota_reservations
          SET status = 'settled', actual_amount = $2::bigint,
              completed_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid`,
      [reservationId, actual.toString()],
    );
  });
}

/** Release reserved capacity after a provider call fails before billable usage. */
export async function releasePersonalMediaQuota(reservationId: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<ReservationRow>(
      `SELECT id, tenant_id, user_id, period_start, modality, reserved_amount, status, actual_amount
         FROM personal_media_quota_reservations
        WHERE id = $1::uuid FOR UPDATE`,
      [reservationId],
    );
    const reservation = result.rows[0];
    if (!reservation) throw new Error('PERSONAL_MEDIA_QUOTA_RESERVATION_NOT_FOUND');
    if (reservation.status === 'released' || reservation.status === 'expired') return;
    if (reservation.status !== 'reserved') {
      throw new Error('PERSONAL_MEDIA_QUOTA_RESERVATION_NOT_ACTIVE');
    }
    const reserved = BigInt(reservation.reserved_amount);
    const counterUpdate = await client.query(
      `UPDATE personal_media_quota_months
          SET reserved_amount = reserved_amount - $5::bigint,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND user_id = $2 AND period_start = $3::date AND modality = $4
          AND reserved_amount >= $5::bigint`,
      [
        reservation.tenant_id,
        reservation.user_id,
        reservation.period_start,
        reservation.modality,
        reserved.toString(),
      ],
    );
    if (counterUpdate.rowCount !== 1)
      throw new Error('PERSONAL_MEDIA_QUOTA_COUNTER_INVARIANT_FAILED');
    await client.query(
      `UPDATE personal_media_quota_reservations
          SET status = 'released', completed_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid`,
      [reservationId],
    );
  });
}
