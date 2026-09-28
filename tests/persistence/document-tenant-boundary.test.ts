import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { StageAccessError } from '@/lib/persistence/stage-meta';
import type { OwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';

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

function courseDocument(id: string, name = id) {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe('document tenant boundaries', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://document-tenant-${randomUUID()}`);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'configured');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    // The app-ensured `stage_meta` schema predates the tenant column; migration
    // 0001 supplies it in a real deployment. Reproduce that shape here so the
    // tenant-scoped store has a column to compare against.
    const { ensureStageMetaSchema } = await import('@/lib/persistence/stage-meta');
    const { ensureDocumentSchema } = await import('@openmaic/storage/document/pg');
    const { ensureAssetSchema } = await import('@openmaic/storage/asset/pg');
    await ensureDocumentSchema(pool as never);
    // The owner-bound store always runs with `trackAssetReferences: true`, and
    // the deployment always provisions the asset schema beside it, so the write
    // path's reference maintenance has its tables.
    await ensureAssetSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await pool.query(
      `ALTER TABLE stage_meta
         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    );
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  function store(ownerId: string, tenantId?: string): OwnerScopedDocumentStore {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId,
      ...(tenantId === undefined ? {} : { tenantId }),
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }) as unknown as OwnerScopedDocumentStore;
  }

  it('lists only the documents created in the store tenant', async () => {
    const acme = store('user:alice', 'acme');
    const beta = store('user:alice', 'beta');
    const legacy = store('user:alice');

    await acme.saveDocument(courseDocument('stage-acme'));
    await beta.saveDocument(courseDocument('stage-beta'));

    await expect(acme.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'stage-acme' }),
    ]);
    await expect(beta.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'stage-beta' }),
    ]);
    // Legacy (no tenant) mode is unchanged: it sees every owned live document.
    await expect(legacy.listDocuments()).resolves.toHaveLength(2);
  });

  it('refuses cross-tenant reads and writes for the same owner', async () => {
    const acme = store('user:alice', 'acme');
    const beta = store('user:alice', 'beta');
    await beta.saveDocument(courseDocument('stage-beta'));

    // Reads collapse to the same null a foreign or missing stage answers.
    await expect(acme.loadDocument('stage-beta')).resolves.toBeNull();
    await expect(acme.getScene('stage-beta', 'scene-1')).resolves.toBeNull();
    await expect(acme.readFreshnessManifest('stage-beta')).resolves.toBeNull();

    await expect(acme.saveDocument(courseDocument('stage-beta', 'edited'))).rejects.toBeInstanceOf(
      StageAccessError,
    );
    await expect(acme.deleteDocument('stage-beta')).rejects.toBeInstanceOf(StageAccessError);

    // The refused mutation left the row untouched.
    await expect(beta.loadDocument('stage-beta')).resolves.toMatchObject({
      stage: { name: 'stage-beta' },
    });
  });

  it('stamps the claimed row with the writer tenant', async () => {
    await store('user:alice', 'acme').saveDocument(courseDocument('stage-acme'));
    const rows = await pool.query(`SELECT tenant_id FROM stage_meta WHERE stage_id = $1`, [
      'stage-acme',
    ]);
    expect((rows.rows[0] as { tenant_id: string }).tenant_id).toBe('acme');
  });

  it('keeps published courses cross-tenant readable but tenant-locked for writes', async () => {
    const beta = store('user:alice', 'beta');
    await beta.saveDocument(courseDocument('stage-beta'));
    await pool.query('UPDATE stage_meta SET is_public = true WHERE stage_id = $1', ['stage-beta']);

    const acme = store('user:alice', 'acme');
    // The documented cross-tenant read rule: public and live is readable.
    await expect(acme.loadDocument('stage-beta')).resolves.toMatchObject({
      stage: { id: 'stage-beta' },
    });
    // Writes are never cross-tenant, public or not.
    await expect(acme.saveDocument(courseDocument('stage-beta', 'edited'))).rejects.toBeInstanceOf(
      StageAccessError,
    );
  });

  it('preserves legacy anonymous behavior when no tenant is supplied', async () => {
    const legacyOwner = store('anon:owner-cookie');
    await legacyOwner.saveDocument(courseDocument('stage-anon'));
    const rows = await pool.query(`SELECT tenant_id FROM stage_meta WHERE stage_id = $1`, [
      'stage-anon',
    ]);
    // The schema's default sentinel, not an application-chosen tenant.
    expect((rows.rows[0] as { tenant_id: string }).tenant_id).toBe('default');
    await expect(legacyOwner.loadDocument('stage-anon')).resolves.toMatchObject({
      stage: { id: 'stage-anon' },
    });
  });
});
