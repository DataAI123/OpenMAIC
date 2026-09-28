import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The HTTP face of the document tenant boundary.
 *
 * The owner boundary is mocked to hand the route a server-resolved identity
 * carrying a tenant (the shape `withRequestOwnerId` produces from
 * `auth_sessions.active_tenant_id`); everything below it — the persistence
 * route, the owner-bound store, the tenant gate — is the real code against a
 * real PostgreSQL engine.
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

function courseDocument(id: string) {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name: id, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: id,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe('persistence route tenant boundary', () => {
  let pool: PGlitePool;
  let connectionString: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    connectionString = `postgres://persistence-tenant-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', connectionString);
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    // The `/api/stages` index gates on the agent runtime being configured; the
    // persistence route beneath it does not.
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    // Migration 0001 supplies the tenant column in a real deployment; the
    // app-ensured schema does not, so add it to the test database.
    await pool.query(
      `ALTER TABLE stage_meta
         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    );
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function seed(ownerId: string, tenantId: string, stageId: string) {
    const { createOwnerBoundDocumentStore } =
      await import('@/lib/persistence/owner-bound-document-store');
    const { validateAppScene, validateAppStage } = await import('@/lib/document-store/validators');
    const store = createOwnerBoundDocumentStore({
      pool,
      ownerId,
      tenantId,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    await store.saveDocument(courseDocument(stageId));
  }

  function call(ownerId: string, tenantId: string, path: string, init: RequestInit = {}) {
    return handleRequest(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          'x-test-owner': ownerId,
          'x-test-tenant': tenantId,
        },
      }),
    );
  }

  async function handleRequest(request: Request): Promise<Response> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(request, { poolFactory: () => pool as never });
  }

  it('reads and writes only within the session tenant', async () => {
    await seed('user:alice', 'acme', 'stage-acme');
    await seed('user:alice', 'beta', 'stage-beta');

    const acmeRead = await call('user:alice', 'acme', '/api/persistence/documents/stage-acme');
    expect(acmeRead.status).toBe(200);
    await expect(acmeRead.json()).resolves.toMatchObject({ stage: { id: 'stage-acme' } });

    // Same owner, different tenant: indistinguishable from a missing document.
    const crossRead = await call('user:alice', 'acme', '/api/persistence/documents/stage-beta');
    expect(crossRead.status).toBe(404);
    await expect(crossRead.json()).resolves.toMatchObject({
      error: { code: 'DOCUMENT_NOT_FOUND' },
    });

    const crossWrite = await call('user:alice', 'acme', '/api/persistence/documents/stage-beta', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(courseDocument('stage-beta')),
    });
    expect(crossWrite.status).toBe(404);

    // The refused write did not mutate the row.
    const betaRead = await call('user:alice', 'beta', '/api/persistence/documents/stage-beta');
    expect(betaRead.status).toBe(200);
  });

  it('lists only the caller tenant courses through the stages index', async () => {
    await seed('user:alice', 'acme', 'stage-acme');
    await seed('user:alice', 'beta', 'stage-beta');

    const { GET: listStages } = await import('@/app/api/stages/route');
    const response = await listStages(
      new NextRequest('http://localhost/api/stages', {
        headers: { 'x-test-owner': 'user:alice', 'x-test-tenant': 'acme' },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stages: [expect.objectContaining({ id: 'stage-acme' })],
    });
  });
});
