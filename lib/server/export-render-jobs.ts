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
 */
export async function recordRenderJobOwner(jobId: string, ownerId: string): Promise<void> {
  if (!isSafeRenderJobId(jobId)) throw new TypeError('EXPORT_RENDER_JOB_INVALID_ID');
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new TypeError('EXPORT_RENDER_JOB_REQUIRES_OWNER');
  }
  const pool = await getPool();
  await pool.query(
    `INSERT INTO export_render_job_owners (job_id, owner_id)
     VALUES ($1, $2)
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, ownerId],
  );
  await pool
    .query(
      `DELETE FROM export_render_job_owners
        WHERE created_at < CURRENT_TIMESTAMP - ${RETENTION_INTERVAL_SQL}`,
    )
    .catch(() => undefined);
}

/**
 * Whether `ownerId` owns `jobId`. A malformed, foreign, or unknown id all return
 * false so callers can answer one uniform 404; only a store outage throws (the
 * caller must fail closed).
 */
export async function assertRenderJobOwnedBy(jobId: string, ownerId: string): Promise<boolean> {
  if (!isSafeRenderJobId(jobId)) return false;
  const pool = await getPool();
  const result = await pool.query(
    `SELECT 1 FROM export_render_job_owners
      WHERE job_id = $1 AND owner_id = $2
      LIMIT 1`,
    [jobId, ownerId],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}
