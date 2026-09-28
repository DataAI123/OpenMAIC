import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveOidcAssetPrincipal,
  type AssetAccessQueryable,
} from '@/lib/persistence/oidc-asset-access';

function asQueryable(db: PGlite): AssetAccessQueryable {
  return {
    async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await db.query(text, params as never);
      return { rows: result.rows as TRow[] };
    },
  };
}

describe('OIDC asset principal resolution', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(`
      CREATE TABLE asset_entries (id TEXT PRIMARY KEY, principal TEXT NOT NULL);
      CREATE TABLE document_asset_refs (stage_id TEXT NOT NULL, asset_id TEXT NOT NULL);
      CREATE TABLE stage_meta (
        stage_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        is_public BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMPTZ
      );
      INSERT INTO asset_entries (id, principal) VALUES
        ('alice-private', 'user:alice'),
        ('bob-private', 'user:bob'),
        ('bob-public', 'user:bob'),
        ('shared-legacy', 'shared'),
        ('tombstoned', 'user:alice');
      INSERT INTO stage_meta (stage_id, owner_id, is_public, deleted_at) VALUES
        ('alice-private-course', 'user:alice', FALSE, NULL),
        ('bob-public-course', 'user:bob', TRUE, NULL),
        ('alice-rebinding-course', 'user:alice', TRUE, NULL),
        ('legacy-public-course', 'anon:legacy', TRUE, NULL),
        ('deleted-public-course', 'user:alice', TRUE, now());
      INSERT INTO document_asset_refs (stage_id, asset_id) VALUES
        ('alice-private-course', 'alice-private'),
        ('bob-public-course', 'bob-public'),
        ('alice-rebinding-course', 'bob-private'),
        ('legacy-public-course', 'shared-legacy'),
        ('deleted-public-course', 'tombstoned');
    `);
  });

  afterEach(async () => db.close());

  it('allocates with the server-derived owner principal and denies mutation shapes', async () => {
    const queryable = asQueryable(db);
    await expect(
      resolveOidcAssetPrincipal(queryable, 'user:alice', {
        method: 'POST',
        url: '/assets',
      }),
    ).resolves.toEqual({ key: 'user:alice', learnerKey: 'user:alice' });

    for (const request of [
      { method: 'PUT', url: '/assets/alice-private/content' },
      { method: 'DELETE', url: '/assets/alice-private' },
      { method: 'POST', url: '/assets/alice-private/content' },
      { method: 'GET', url: '/assets/alice-private/content?download=1' },
    ]) {
      await expect(
        resolveOidcAssetPrincipal(queryable, 'user:alice', request),
      ).resolves.toBeUndefined();
    }
  });

  it('allows owner assets and matching live public references, while hiding private or rebound assets', async () => {
    const queryable = asQueryable(db);
    const read = (ownerId: string, assetId: string) =>
      resolveOidcAssetPrincipal(queryable, ownerId, {
        method: 'GET',
        url: `/assets/${assetId}/content`,
      });

    await expect(read('user:alice', 'alice-private')).resolves.toEqual({
      key: 'user:alice',
      learnerKey: 'user:alice',
    });
    await expect(read('user:alice', 'bob-private')).resolves.toBeUndefined();
    await expect(read('public:anonymous', 'bob-public')).resolves.toEqual({
      key: 'user:bob',
      learnerKey: 'public:anonymous',
    });
    await expect(read('user:alice', 'bob-public')).resolves.toEqual({
      key: 'user:bob',
      learnerKey: 'user:alice',
    });
    await expect(read('public:anonymous', 'shared-legacy')).resolves.toEqual({
      key: 'shared',
      learnerKey: 'public:anonymous',
    });
    await expect(read('public:anonymous', 'tombstoned')).resolves.toBeUndefined();
    await expect(read('public:anonymous', 'missing')).resolves.toBeUndefined();
  });
});
