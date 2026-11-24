import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The HTTP face of the agent-session tenant boundary.
 *
 * The owner boundary is mocked to hand the route a server-resolved identity
 * carrying a tenant (the shape `withRequestOwnerId` produces from
 * `auth_sessions.active_tenant_id`); the route, the per-tenant store cache and
 * the tenant-scoped queries are the real code against a real PostgreSQL engine.
 * Both seeded sessions share ONE owner id — exactly the situation the boundary
 * exists for — so the tenant is the only thing separating them.
 */
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: async (
    request: Pick<Request, 'headers' | 'method' | 'url'>,
    handler: (
      ownerId: string,
      responseHeaders: Headers,
      identity?: { ownerId: string; tenantId?: string },
    ) => Promise<Response>,
  ) => {
    const ownerId = request.headers.get('x-test-owner') ?? 'public:anonymous';
    const tenantId = request.headers.get('x-test-tenant') ?? undefined;
    return handler(ownerId, new Headers(), {
      ownerId,
      ...(tenantId === undefined ? {} : { tenantId }),
    });
  },
}));

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

describe('agent sessions route tenant boundary', () => {
  const owner = 'user:shared-owner';
  let pool: PGlitePool;
  let connectionString: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    connectionString = `postgres://agent-sessions-tenant-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', connectionString);
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    const { getAgentSessionStore } = await import('@/lib/server/agent-runtime/store');
    await (
      await getAgentSessionStore('tenant-a')
    ).createSession({ id: 'a1', ownerId: owner, prompt: 'a' });
    await (
      await getAgentSessionStore('tenant-b')
    ).createSession({ id: 'b1', ownerId: owner, prompt: 'b' });
  }, 20_000);

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function listFor(tenantId?: string): Promise<Array<{ id: string; tenantId?: string }>> {
    const { GET } = await import('@/app/api/agent/sessions/route');
    const headers: Record<string, string> = { 'x-test-owner': owner };
    if (tenantId !== undefined) headers['x-test-tenant'] = tenantId;
    const request = new NextRequest('http://localhost/api/agent/sessions', { headers });
    const response = await GET(request);
    expect(response.status).toBe(200);
    return (await response.json()) as Array<{ id: string; tenantId?: string }>;
  }

  it("lists only the caller tenant's sessions and reports their tenant", async () => {
    const a = await listFor('tenant-a');
    const b = await listFor('tenant-b');

    expect(a.map((session) => session.id)).toEqual(['a1']);
    expect(a[0]?.tenantId).toBe('tenant-a');
    expect(b.map((session) => session.id)).toEqual(['b1']);
    expect(b[0]?.tenantId).toBe('tenant-b');
  }, 15_000);

  it('leaves the legacy unscoped request seeing every tenant (unchanged contract)', async () => {
    const all = await listFor();
    expect(all.map((session) => session.id).sort()).toEqual(['a1', 'b1']);
  });
});
