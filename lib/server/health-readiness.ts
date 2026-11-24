import { Pool } from 'pg';

import { isAgentRuntimeEnabled } from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';

const log = createLogger('HealthReadiness');
const READINESS_CACHE_MS = 2_000;
const DATABASE_PROBE_TIMEOUT_MS = 1_000;

// Keep this aligned with the newest migration required by the application.
// Migration checksums remain the migrator's responsibility, not a per-request
// readiness query.
const MINIMUM_SCHEMA_VERSION = 23;

type ReadinessOutcome = 'ready' | 'missing-config' | 'database-unavailable' | 'schema-not-ready';

interface CachedReadiness {
  key: string;
  outcome: ReadinessOutcome;
  expiresAt: number;
}

interface InFlightReadiness {
  key: string;
  promise: Promise<ReadinessOutcome>;
}

let cachedReadiness: CachedReadiness | undefined;
let inFlightReadiness: InFlightReadiness | undefined;

function requiresDatabase(): boolean {
  return process.env.OPENMAIC_AUTH_MODE?.trim() === 'oidc' || isAgentRuntimeEnabled();
}

async function probeDatabase(connectionString: string): Promise<ReadinessOutcome> {
  let pool: Pool | undefined;
  try {
    pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: DATABASE_PROBE_TIMEOUT_MS,
      query_timeout: DATABASE_PROBE_TIMEOUT_MS,
      statement_timeout: DATABASE_PROBE_TIMEOUT_MS,
    });
    const result = await pool.query<{ version: number | null }>(
      'SELECT max(version) AS version FROM schema_migrations',
    );
    const version = Number(result.rows[0]?.version ?? 0);
    return Number.isSafeInteger(version) && version >= MINIMUM_SCHEMA_VERSION
      ? 'ready'
      : 'schema-not-ready';
  } catch {
    return 'database-unavailable';
  } finally {
    await pool?.end().catch(() => {});
  }
}

/**
 * Check only dependencies required for accepting application traffic.
 * Legacy mode may run without PostgreSQL; OIDC identity and the durable agent
 * runtime may not. This raw read-only probe intentionally avoids the
 * persistence provider, whose bootstrap ensures/mutates schema.
 */
export function getReadinessOutcome(): Promise<ReadinessOutcome> {
  const required = requiresDatabase();
  const connectionString = process.env.DATABASE_URL?.trim() ?? '';
  if (!required) return Promise.resolve('ready');
  if (!connectionString) return Promise.resolve('missing-config');

  // The connection string stays process-local and is never logged or returned.
  const key = `${process.env.OPENMAIC_AUTH_MODE?.trim() ?? 'legacy'}:${connectionString}`;
  const now = Date.now();
  if (cachedReadiness?.key === key && cachedReadiness.expiresAt > now) {
    return Promise.resolve(cachedReadiness.outcome);
  }
  if (inFlightReadiness?.key === key) return inFlightReadiness.promise;

  const promise = probeDatabase(connectionString).then((outcome) => {
    if (outcome !== 'ready') {
      // Avoid logging driver errors, which can contain connection details.
      log.warn(`Required dependency check failed: ${outcome}`);
    }
    cachedReadiness = { key, outcome, expiresAt: Date.now() + READINESS_CACHE_MS };
    return outcome;
  });
  inFlightReadiness = { key, promise };
  const clearInFlight = () => {
    if (inFlightReadiness?.promise === promise) inFlightReadiness = undefined;
  };
  void promise.then(clearInFlight, clearInFlight);
  return promise;
}
