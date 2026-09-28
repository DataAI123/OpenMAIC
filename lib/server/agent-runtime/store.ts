import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/agent-session/pg';
import { extractObservedUrls } from '@openmaic/storage';
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { notifyDurableAgentEvent } from './event-notify-bus';

interface AgentSessionStoreState {
  connectionString?: string;
  /** One store per (connection string, tenant); empty-string key = legacy. */
  stores?: Map<string, Promise<PgAgentSessionStore>>;
}

const AGENT_SESSION_STORE_STATE_KEY = Symbol.for('openmaic.agent-session.store');
const globalState = globalThis as typeof globalThis & {
  [AGENT_SESSION_STORE_STATE_KEY]?: AgentSessionStoreState;
};
const storeState = (globalState[AGENT_SESSION_STORE_STATE_KEY] ??= {});

/**
 * Adapt a node-postgres pool to the storage package's transaction contract.
 * Every transaction uses one checked-out client for its entire lifetime.
 */
export function nodePostgresTransaction(pool: Pool): WithTransaction {
  return async <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function createAgentSessionStore(
  connectionString: string,
  tenantId: string | undefined,
): Promise<PgAgentSessionStore> {
  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureAgentSessionSchema(pool);
  // URL observations from user-authored prompt/message text are registered
  // inside the same business transaction that creates the session / posts the
  // message (reference session-store semantics), so they commit atomically and
  // a registration failure aborts the write. The hooks run only after the
  // store is constructed, so the closure reference is always assigned.
  const store: PgAgentSessionStore = new PgAgentSessionStore(pool, {
    withTransaction: nodePostgresTransaction(pool),
    // A tenant-bound store can only ever read or write its own tenant's rows.
    // Absent in legacy anonymous mode, which has no tenant dimension.
    ...(tenantId === undefined ? {} : { tenantScope: tenantId }),
    onSessionCreated: async (transaction, meta): Promise<void> => {
      await store.registerSessionUrls(
        meta.id,
        extractObservedUrls(meta.prompt),
        'user',
        transaction,
      );
    },
    onUserMessagePosted: async (transaction, input): Promise<void> => {
      await store.registerSessionUrls(
        input.session.id,
        extractObservedUrls(input.text),
        'user',
        transaction,
      );
    },
    // Wake the per-session SSE tail (and the running session's runner) in the
    // SAME transaction as the durable append: PG emits NOTIFY only at commit,
    // so the reader wakes exactly when the row becomes visible. Lossy by
    // design — a dropped notification degrades only latency, never
    // correctness, because every stream keeps its fallback poll.
    onSessionEventAppended: (transaction, event): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'session', sessionId: event.sessionId }),
    onOwnerEventAppended: (transaction, event): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'owner', ownerId: event.ownerId }),
    onCancelRequested: (transaction, sessionId): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'session', sessionId }),
  });
  return store;
}

/**
 * Return the process-wide agent-session store for one tenant, initializing its
 * schema lazily. `tenantId` is resolved server-side (from the application
 * session) and never from request input; omitted means the legacy anonymous
 * store, which has no tenant dimension. A failed initialization clears only its
 * own entry so a later request can retry after the database becomes available,
 * leaving other tenants' initialized stores valid.
 */
export function getAgentSessionStore(tenantId?: string): Promise<PgAgentSessionStore> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Promise.reject(new Error('Agent runtime requires DATABASE_URL'));
  }
  if (storeState.connectionString !== connectionString) {
    // A changed connection string invalidates every cached store, tenant or not.
    storeState.connectionString = connectionString;
    storeState.stores = new Map();
  }
  const stores = (storeState.stores ??= new Map());
  const key = tenantId ?? '';
  const existing = stores.get(key);
  if (existing) return existing;

  const initialization = createAgentSessionStore(connectionString, tenantId).catch((error) => {
    if (stores.get(key) === initialization) stores.delete(key);
    throw error;
  });
  stores.set(key, initialization);
  return initialization;
}
