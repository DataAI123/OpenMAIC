import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: async (
    request: Pick<Request, 'headers' | 'method' | 'url'>,
    handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
    options?: {
      allowAnonymousPublicRead?: (req: Pick<Request, 'headers' | 'method' | 'url'>) => boolean;
    },
  ) => {
    const ownerId = request.headers.get('x-test-owner') ?? 'public:anonymous';
    if (ownerId === 'public:anonymous' && !options?.allowAnonymousPublicRead?.(request)) {
      return Response.json({ success: false, errorCode: 'LOGIN_REQUIRED' }, { status: 401 });
    }
    return handler(ownerId, new Headers());
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
      generationComplete: true,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function assetUpload(bytes: number[]) {
  const form = new FormData();
  form.append('meta', new Blob([JSON.stringify({})], { type: 'application/json' }), 'meta');
  form.append('bytes', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'bytes');
  return form;
}

describe('OIDC persistence asset route', () => {
  let pool: PGlitePool;
  let connectionString: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    connectionString = `postgres://oidc-assets-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', connectionString);
    vi.stubEnv('OPENMAIC_AUTH_MODE', 'oidc');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('uploads per-user assets, permits owner/public reads, and denies foreign private reads', async () => {
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const provider = await getServerPersistenceProvider(connectionString, () => pool as never);
    const { createOwnerBoundDocumentStore } =
      await import('@/lib/persistence/owner-bound-document-store');
    const { validateAppScene, validateAppStage } = await import('@/lib/document-store/validators');
    const aliceStore = createOwnerBoundDocumentStore({
      pool,
      ownerId: 'user:alice',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const bobStore = createOwnerBoundDocumentStore({
      pool,
      ownerId: 'user:bob',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    await aliceStore.saveDocument(courseDocument('alice-public-course'));
    await bobStore.saveDocument(courseDocument('bob-public-course'));
    await aliceStore.saveDocument(courseDocument('alice-deleted-course'));
    await pool.query(`UPDATE stage_meta SET is_public = TRUE WHERE stage_id IN ($1, $2, $3)`, [
      'alice-public-course',
      'bob-public-course',
      'alice-deleted-course',
    ]);
    await pool.query('UPDATE stage_meta SET deleted_at = now() WHERE stage_id = $1', [
      'alice-deleted-course',
    ]);

    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const call = (request: Request) =>
      handlePersistenceRequest(request, { poolFactory: () => pool as never });

    const uploaded = await call(
      new Request('http://localhost/api/persistence/assets', {
        method: 'POST',
        headers: { 'x-test-owner': 'user:alice' },
        body: assetUpload([1, 2, 3]),
      }),
    );
    expect(uploaded.status).toBe(201);
    const { id: assetId } = (await uploaded.json()) as { id: string };
    const reboundAssetId = await provider.assetStore.put(
      { key: 'user:alice' },
      new Blob([new Uint8Array([7])], { type: 'image/png' }),
      {},
    );
    const privateAssetId = await provider.assetStore.put(
      { key: 'user:alice' },
      new Blob([new Uint8Array([5])], { type: 'image/png' }),
      {},
    );

    await pool.query(
      `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
       VALUES ($1, 'stage', '', $2), ($3, 'stage', '', $2), ($4, 'stage', '', $2),
              ($3, 'stage', '', $5)`,
      ['alice-public-course', assetId, 'bob-public-course', 'alice-deleted-course', reboundAssetId],
    );

    const ownerRead = await call(
      new Request(`http://localhost/api/persistence/assets/${assetId}/content`, {
        headers: { 'x-test-owner': 'user:alice' },
      }),
    );
    expect(ownerRead.status).toBe(200);
    expect(new Uint8Array(await ownerRead.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const foreignRead = await call(
      new Request(`http://localhost/api/persistence/assets/${privateAssetId}/content`, {
        headers: { 'x-test-owner': 'user:bob' },
      }),
    );
    expect(foreignRead.status).toBe(401);

    const referencedPublicRead = await call(
      new Request(`http://localhost/api/persistence/assets/${assetId}/content`, {
        headers: { 'x-test-owner': 'user:bob' },
      }),
    );
    expect(referencedPublicRead.status).toBe(200);

    const publicRead = await call(
      new Request(`http://localhost/api/persistence/assets/${assetId}/content`),
    );
    expect(publicRead.status).toBe(200);

    // A public foreign course cannot turn an Alice asset into a Bob asset.
    const reboundRead = await call(
      new Request(`http://localhost/api/persistence/assets/${reboundAssetId}/content`),
    );
    expect(reboundRead.status).toBe(401);

    const deletedOnly = await provider.assetStore.put(
      { key: 'user:alice' },
      new Blob([new Uint8Array([4])], { type: 'image/png' }),
      {},
    );
    await pool.query(
      `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
       VALUES ($1, 'stage', '', $2)`,
      ['alice-deleted-course', deletedOnly],
    );
    const tombstonedRead = await call(
      new Request(`http://localhost/api/persistence/assets/${deletedOnly}/content`),
    );
    expect(tombstonedRead.status).toBe(401);

    const replace = await call(
      new Request(`http://localhost/api/persistence/assets/${assetId}/content`, {
        method: 'PUT',
        headers: { 'x-test-owner': 'user:alice' },
        body: assetUpload([9]),
      }),
    );
    expect(replace.status).toBe(401);
  });
});
