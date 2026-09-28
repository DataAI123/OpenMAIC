import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Queryable, WithTransaction } from '@openmaic/storage/asset/pg';

/**
 * The asset registry's tenant boundary, exercised against a real PostgreSQL
 * engine.
 *
 * One user reaches `asset_entries` with the SAME `principal` key in every
 * tenant they belong to, so the principal alone cannot separate one tenant's
 * assets from another's. A principal that carries a tenant therefore has every
 * entry statement constrained to it; a legacy principal (no tenant) keeps the
 * pre-tenant contract, including seeing the rows every one of its tenants
 * wrote.
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

/** An in-memory byte layer: its bytes live outside the registry's database. */
function memoryByteStore() {
  const bytes = new Map<string, Uint8Array>();
  return {
    writesOutsideRegistryDatabase: true as const,
    async write(hash: string, value: Uint8Array) {
      bytes.set(hash, value);
    },
    async read(hash: string) {
      return bytes.get(hash) ?? null;
    },
    async delete(hash: string) {
      bytes.delete(hash);
    },
  };
}

describe('asset tenant boundaries', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { ensureAssetSchema } = await import('@openmaic/storage/asset/pg');
    await ensureAssetSchema(pool as never);
  });

  afterEach(async () => {
    await pool.end();
  });

  async function store(quotaBytes?: number) {
    const { PgAssetStore } = await import('@openmaic/storage/asset/pg');
    return new PgAssetStore(pool as never, {
      withTransaction: transactionFor(pool),
      byteStore: memoryByteStore() as never,
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
    });
  }

  const blob = (text: string) => new Blob([text], { type: 'text/plain' });

  it('scopes reads to the principal tenant for a shared principal', async () => {
    const assets = await store();
    const acme = { key: 'user:alice', tenantId: 'acme' };
    const beta = { key: 'user:alice', tenantId: 'beta' };

    const acmeId = await assets.put(acme, blob('from acme'));
    const betaId = await assets.put(beta, blob('from beta'));

    // Each tenant reads exactly its own entries; the other's id is the same
    // null a foreign or missing id answers (no existence oracle).
    await expect(assets.resolve(acme, acmeId)).resolves.toMatchObject({ mime: 'text/plain' });
    await expect(assets.resolve(acme, betaId)).resolves.toBeNull();
    await expect(assets.resolve(beta, betaId)).resolves.toMatchObject({ mime: 'text/plain' });
    await expect(assets.resolve(beta, acmeId)).resolves.toBeNull();
    await expect(assets.identify(acme, betaId)).resolves.toBeNull();
  });

  it('keeps every tenant readable to a legacy principal', async () => {
    const assets = await store();
    const acme = { key: 'user:alice', tenantId: 'acme' };
    const beta = { key: 'user:alice', tenantId: 'beta' };
    const acmeId = await assets.put(acme, blob('from acme'));
    const betaId = await assets.put(beta, blob('from beta'));

    // The legacy principal carries no tenant, so no statement is filtered and
    // its own assets from either tenant stay reachable -- the pre-tenant
    // contract, byte-for-byte.
    const legacy = { key: 'user:alice' };
    await expect(assets.resolve(legacy, acmeId)).resolves.toMatchObject({ mime: 'text/plain' });
    await expect(assets.resolve(legacy, betaId)).resolves.toMatchObject({ mime: 'text/plain' });
  });

  it('accounts quota per tenant rather than per shared principal', async () => {
    // Two entries of 4 bytes each would exceed a 6-byte ceiling if they shared
    // one bucket; scoped per tenant, each fits on its own.
    const assets = await store(6);
    const acme = { key: 'user:alice', tenantId: 'acme' };
    const beta = { key: 'user:alice', tenantId: 'beta' };

    await expect(assets.put(acme, blob('aaaa'))).resolves.toEqual(expect.any(String));
    await expect(assets.put(beta, blob('bbbb'))).resolves.toEqual(expect.any(String));
    // A second entry in the same tenant is what trips the ceiling.
    await expect(assets.put(acme, blob('cccc'))).rejects.toBeInstanceOf(Error);
  });
});
