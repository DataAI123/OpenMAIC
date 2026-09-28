import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureAgentSessionSchema,
  PgAgentSessionStore,
  type Queryable,
  type WithTransaction,
} from '../../packages/@openmaic/storage/src/agent-session/pg';

/**
 * The agent-session tenant boundary, exercised against a real PostgreSQL engine.
 *
 * One user reaches `agent_sessions` with the SAME `owner_id` in every tenant
 * they belong to, so owner alone cannot separate one tenant's conversations
 * from another's. A tenant-scoped store therefore stamps `tenant_id` on create
 * and constrains every by-id / by-owner statement to it; an unscoped store
 * keeps the legacy contract (no tenant dimension) unchanged.
 */
class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params as never);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params as never),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

function transactionFor(pool: PGlitePool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client as Queryable);
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

describe('agent session tenant boundaries', () => {
  const owner = 'user:shared-owner';
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureAgentSessionSchema(pool as never);
  });

  afterEach(async () => {
    await pool.end();
  });

  function store(tenantId?: string): PgAgentSessionStore {
    return new PgAgentSessionStore(pool as never, {
      withTransaction: transactionFor(pool),
      ...(tenantId === undefined ? {} : { tenantScope: tenantId }),
    });
  }

  it('stamps the tenant on create and exposes it on the meta', async () => {
    const meta = await store('tenant-a').createSession({
      id: 'a1',
      ownerId: owner,
      prompt: 'hello',
    });

    expect(meta.tenantId).toBe('tenant-a');
    const row = await pool.query('SELECT tenant_id FROM agent_sessions WHERE id = $1', ['a1']);
    expect((row.rows[0] as { tenant_id: string | null }).tenant_id).toBe('tenant-a');
  });

  it("lists only the caller tenant's sessions for a shared owner", async () => {
    await store('tenant-a').createSession({ id: 'a1', ownerId: owner, prompt: 'a' });
    await store('tenant-b').createSession({ id: 'b1', ownerId: owner, prompt: 'b' });

    const a = await store('tenant-a').listSessionsByOwner(owner);
    const b = await store('tenant-b').listSessionsByOwner(owner);

    expect(a.map((session) => session.id)).toEqual(['a1']);
    expect(b.map((session) => session.id)).toEqual(['b1']);
  });

  it("reads another tenant's session by id as absent (no oracle)", async () => {
    await store('tenant-a').createSession({ id: 'a1', ownerId: owner, prompt: 'a' });

    expect(await store('tenant-a').getSession('a1')).toMatchObject({ id: 'a1' });
    expect(await store('tenant-b').getSession('a1')).toBeNull();
  });

  it("refuses another tenant's mutation and leaves the row intact", async () => {
    await store('tenant-a').createSession({ id: 'a1', ownerId: owner, prompt: 'a' });

    const deleted = await store('tenant-b').softDeleteSession('a1', owner);
    expect(deleted).toBe(false);
    expect(await store('tenant-a').getSession('a1')).toMatchObject({ id: 'a1' });
  });

  it('keeps the legacy unscoped contract: no tenant, sees every tenant', async () => {
    const legacy = await store().createSession({
      id: 'anon-1',
      ownerId: 'anon:legacy',
      prompt: 'legacy',
    });
    expect(legacy.tenantId).toBeUndefined();
    const row = await pool.query('SELECT tenant_id FROM agent_sessions WHERE id = $1', ['anon-1']);
    expect((row.rows[0] as { tenant_id: string | null }).tenant_id).toBeNull();

    await store('tenant-a').createSession({ id: 'a1', ownerId: owner, prompt: 'a' });
    await store('tenant-b').createSession({ id: 'b1', ownerId: owner, prompt: 'b' });

    // Unscoped: the pre-tenant contract, addressed by owner alone.
    const all = await store().listSessionsByOwner(owner);
    expect(all.map((session) => session.id).sort()).toEqual(['a1', 'b1']);
    // Scoped: confined to one tenant.
    expect((await store('tenant-a').listSessionsByOwner(owner)).map((s) => s.id)).toEqual(['a1']);
  });

  it('claims across tenants and reports the row tenant to the run', async () => {
    await store('tenant-a').createSession({ id: 'a1', ownerId: owner, prompt: 'a' });

    // The scan is the worker's cross-tenant entry point; it must find queued
    // work in any tenant and hand the tenant back so the run can scope itself.
    const claim = await store().claimNextSession('worker-0', 100, {
      leaseTtlMs: 10_000,
      maxAttempts: 3,
    });
    expect(claim).toMatchObject({ id: 'a1', tenantId: 'tenant-a' });
  });
});
