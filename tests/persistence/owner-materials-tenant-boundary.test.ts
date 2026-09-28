import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Queryable, QueryResult } from '@openmaic/storage/document/pg';

import {
  ensureOwnerMaterialSchema,
  finalizeOwnerMaterial,
  getReadyOwnerMaterials,
  listOwnerMaterials,
  reclaimStaleOwnerMaterialUploads,
  registerOwnerMaterial,
} from '@/lib/persistence/owner-materials';

/**
 * The owner material library's tenant boundary, exercised against a real
 * PostgreSQL engine.
 *
 * One user reaches `owner_material` with the SAME `owner_id` in every tenant
 * they belong to, so the owner alone cannot separate one tenant's uploads from
 * another's. Every read/write takes an optional tenant and, when supplied,
 * constrains the statement to it; omitted, the legacy owner-only contract
 * stands unchanged.
 */
class PGliteQueryable implements Queryable {
  constructor(readonly db: PGlite) {}

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<TRow>> {
    const result = await this.db.query<TRow>(text, params as never);
    return { rows: result.rows };
  }

  async connect() {
    return {
      query: <TRow extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        params?: unknown[],
      ) => this.query<TRow>(text, params),
      release() {},
    };
  }
}

describe('owner material tenant boundaries', () => {
  const owner = 'user:shared-owner';
  let db: PGlite;
  let pool: PGliteQueryable;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    pool = new PGliteQueryable(db);
    await ensureOwnerMaterialSchema(pool);
  });

  afterEach(async () => {
    await db.close();
  });

  async function reserve(id: string, tenantId?: string) {
    return registerOwnerMaterial(
      pool,
      {
        id,
        ownerId: owner,
        kind: 'source',
        mime: 'application/pdf',
        bytes: 10,
        originalName: `${id}.pdf`,
        ossKey: `materials/${owner}/${id}`,
        extraction: { status: 'idle' },
        ...(tenantId === undefined ? {} : { tenantId }),
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
  }

  async function ready(id: string, tenantId?: string) {
    const record = await reserve(id, tenantId);
    return finalizeOwnerMaterial(pool, record.id, 10, 'a'.repeat(64));
  }

  it('lists and resolves only the caller tenant for a shared owner', async () => {
    await ready('mat-a', 'tenant-a');
    await ready('mat-b', 'tenant-b');

    expect((await listOwnerMaterials(pool, owner, 'tenant-a')).map((m) => m.id)).toEqual(['mat-a']);
    expect((await listOwnerMaterials(pool, owner, 'tenant-b')).map((m) => m.id)).toEqual(['mat-b']);

    // A foreign tenant's id resolves to nothing (no existence oracle).
    const resolved = await getReadyOwnerMaterials(pool, owner, ['mat-a', 'mat-b'], 'tenant-a');
    expect(resolved.map((m) => m.id)).toEqual(['mat-a']);

    // Legacy (unscoped) still sees every tenant's uploads for the owner.
    expect((await listOwnerMaterials(pool, owner)).map((m) => m.id).sort()).toEqual([
      'mat-a',
      'mat-b',
    ]);
  });

  it('scopes the stale-upload reclaim to the caller tenant', async () => {
    // Left in the `uploading` state a crashed upload leaves behind, then aged
    // past the 24h reclaim window.
    await reserve('mat-a', 'tenant-a');
    await reserve('mat-b', 'tenant-b');
    await pool.query(`UPDATE owner_material SET created_at = created_at - 1000000000`);

    const deleted: string[] = [];
    const deleteBytes = async (key: string) => {
      deleted.push(key);
    };
    // A tenant-b sweep must not touch tenant-a's stale reservation.
    await reclaimStaleOwnerMaterialUploads(pool, owner, deleteBytes, 'tenant-b');
    expect(deleted).toEqual([`materials/${owner}/mat-b`]);

    await reclaimStaleOwnerMaterialUploads(pool, owner, deleteBytes, 'tenant-a');
    expect(deleted).toEqual([`materials/${owner}/mat-b`, `materials/${owner}/mat-a`]);
  });
});
