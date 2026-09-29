/**
 * Durable owner binding for MP4 render-service jobs.
 *
 * The export-video pipeline is a thin proxy over an EXTERNAL render service that
 * has no notion of our users, so a client that learns a job id could poll,
 * cancel, or download another user's rendered video. This module records
 * `job_id -> owner_id` when a submit is relayed, and re-checks that binding on
 * every by-id access so an unbound or foreign job is indistinguishable from a
 * missing one (the routes answer a plain 404 for both — no existence oracle).
 *
 * The binding is an AUTHORIZATION check, so it fails closed: when the database
 * is unavailable the guards throw {@link ExportRenderJobDatabaseUnavailableError}
 * and the route refuses the request rather than falling open. (Contrast the media
 * quota meter, which skips unauthenticated owners — here "skip" would leak.)
 */
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

/** Bindings live only long enough to poll, cancel, or re-download a finished render. */
const RETENTION_INTERVAL_SQL = `INTERVAL '7 days'`;

/** Printed-ASCII job ids without a path separator or whitespace/control char. */
const JOB_ID_MAX_LENGTH = 256;
const UNSAFE_JOB_ID = /[\s\x00-\x1f\x7f/\\]/;

/** Thrown when the owner store is unreachable; callers must treat it as fail-closed. */
export class ExportRenderJobDatabaseUnavailableError extends Error {
  readonly code = 'EXPORT_RENDER_JOB_DATABASE_UNAVAILABLE';

  constructor() {
    super('Export render job ownership store is unavailable');
    this.name = 'ExportRenderJobDatabaseUnavailableError';
  }
}

/**
 * Whether a client-supplied job id is shaped so it is even worth a lookup. This
 * only rejects pathological input (huge strings, path separators, control
 * chars); a syntactically fine but unknown id still resolves to "not owned".
 */
export function isSafeRenderJobId(jobId: unknown): jobId is string {
  return (
    typeof jobId === 'string' &&
    jobId.length >= 1 &&
    jobId.length <= JOB_ID_MAX_LENGTH &&
    !UNSAFE_JOB_ID.test(jobId)
  );
}

async function getPool(): Promise<Pool> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new ExportRenderJobDatabaseUnavailableError();
  const { pool } = await getServerPersistenceProvider(connectionString);
  return pool as unknown as Pool;
}

/**
 * Bind a freshly-submitted job to its owner. First writer wins: the insert is
 * idempotent (`ON CONFLICT DO NOTHING`) so a retried submit cannot silently
 * re-point an already-bound job at a different owner. A best-effort sweep then
 * reclaims expired bindings; a sweep failure never fails the submit itself.
 *
 * `tenantId` records the tenant the submit was made under. It is part of the
 * binding, so the same user acting under another tenant cannot poll, cancel, or
 * download a job they submitted elsewhere.
 */
export async function recordRenderJobOwner(
  jobId: string,
  ownerId: string,
  tenantId?: string,
): Promise<void> {
  if (!isSafeRenderJobId(jobId)) throw new TypeError('EXPORT_RENDER_JOB_INVALID_ID');
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new TypeError('EXPORT_RENDER_JOB_REQUIRES_OWNER');
  }
  const pool = await getPool();
  await pool.query(
    `INSERT INTO export_render_job_owners (job_id, owner_id, tenant_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, ownerId, tenantId ?? null],
  );
  await pool
    .query(
      `DELETE FROM export_render_job_owners
        WHERE created_at < CURRENT_TIMESTAMP - ${RETENTION_INTERVAL_SQL}`,
    )
    .catch(() => undefined);
}

/**
 * Concurrency cap for render submits, enforced on the bindings this module
 * already records — no extra table, no job-status bookkeeping the external
 * render service would have to feed back.
 *
 * The cap counts bindings created in the last {@link RENDER_SUBMIT_WINDOW_SECONDS}
 * per (owner, tenant). The window doubles as the self-heal: it is sized above a
 * typical render lifetime, so an abandoned or never-polled job stops counting
 * when it ages out and cannot lock its owner out permanently.
 *
 * This is a SOFT cap: two submits racing between count and insert can both be
 * admitted, exceeding the cap by at most the number of simultaneous requests.
 * Making it strict would need a serialization point (a status column plus
 * terminal-state updates driven by polling, which clients may never do) — not
 * worth it for a cost/abuse bound whose window already limits total throughput.
 */
export const RENDER_SUBMIT_MAX_IN_FLIGHT = 3;
export const RENDER_SUBMIT_WINDOW_SECONDS = 15 * 60;

export interface RenderSubmitLimitResult {
  /** True when the owner is already at the cap and the submit must be refused. */
  readonly limited: boolean;
  /** Seconds until the oldest counted binding leaves the window; only set when limited. */
  readonly retryAfterSeconds?: number;
}

/**
 * Whether one more render submit is allowed for this (owner, tenant), and if
 * not, how long until the oldest counted binding exits the window.
 *
 * Like {@link assertRenderJobOwnedBy} this is a gate on the submit path, so a
 * store outage throws {@link ExportRenderJobDatabaseUnavailableError} and the
 * caller fails closed. `tenantId` scopes the count exactly as it scopes the
 * ownership check: omitted means the legacy owner-only view (tenantless
 * bindings included), supplied means only that tenant's bindings count.
 */
export async function checkRenderSubmitLimit(
  ownerId: string,
  tenantId?: string,
): Promise<RenderSubmitLimitResult> {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new TypeError('EXPORT_RENDER_JOB_REQUIRES_OWNER');
  }
  const pool = await getPool();
  const tenantFilter = tenantId === undefined ? '' : ' AND tenant_id = $2';
  const params: (string | number)[] = tenantId === undefined ? [ownerId] : [ownerId, tenantId];
  const result = await pool.query<{
    active_count: number | string;
    oldest_in_window: Date | string | null;
  }>(
    `WITH edge AS (
       SELECT CURRENT_TIMESTAMP - make_interval(secs => $${params.length + 1}) AS window_start
     )
     SELECT COUNT(*)::int AS active_count, MIN(created_at) AS oldest_in_window
       FROM export_render_job_owners, edge
      WHERE owner_id = $1${tenantFilter}
        AND created_at > edge.window_start`,
    [...params, RENDER_SUBMIT_WINDOW_SECONDS],
  );
  const row = result.rows[0];
  const activeCount = Number(row?.active_count ?? 0);
  if (activeCount < RENDER_SUBMIT_MAX_IN_FLIGHT) return { limited: false };

  const oldest = row?.oldest_in_window;
  const oldestMs =
    typeof oldest === 'string' ? Date.parse(oldest) : (oldest?.getTime() ?? Number.NaN);
  const retryAfterSeconds = Number.isFinite(oldestMs)
    ? Math.max(1, Math.ceil((oldestMs + RENDER_SUBMIT_WINDOW_SECONDS * 1000 - Date.now()) / 1000))
    : RENDER_SUBMIT_WINDOW_SECONDS;
  return { limited: true, retryAfterSeconds };
}

/**
 * Whether `ownerId` owns `jobId`. A malformed, foreign, or unknown id all return
 * false so callers can answer one uniform 404; only a store outage throws (the
 * caller must fail closed).
 *
 * `tenantId`, when supplied, must match the binding's recorded tenant as well:
 * a binding made under one tenant is invisible to the same owner under another,
 * so a job id learned while a user is in two tenants is not a cross-tenant read
 * of which tenant submitted it.
 */
export async function assertRenderJobOwnedBy(
  jobId: string,
  ownerId: string,
  tenantId?: string,
): Promise<boolean> {
  if (!isSafeRenderJobId(jobId)) return false;
  const pool = await getPool();
  const tenantFilter = tenantId === undefined ? '' : ' AND tenant_id = $3';
  const result = await pool.query(
    `SELECT 1 FROM export_render_job_owners
      WHERE job_id = $1 AND owner_id = $2${tenantFilter}
      LIMIT 1`,
    tenantId === undefined ? [jobId, ownerId] : [jobId, ownerId, tenantId],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}
