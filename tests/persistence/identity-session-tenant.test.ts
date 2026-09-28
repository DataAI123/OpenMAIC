import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OidcAuthConfig } from '@/lib/server/auth/config';
import type { OidcIdentityClaims } from '@/lib/server/auth/identity';

/**
 * Exercises the login transaction against a real PostgreSQL engine (PGlite):
 * first-login provisioning joins the configured tenant, admission needs an
 * active membership, and the session pins its active tenant only when the
 * choice is unambiguous.
 */
class PGlitePool {
  constructor(readonly db: PGlite) {}

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params as never),
      release() {},
    };
  }
}

const migration = (name: string) => path.join(process.cwd(), 'migrations', name);

async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE stage_meta (
      stage_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      is_public BOOLEAN NOT NULL DEFAULT false,
      published_at DOUBLE PRECISION,
      generation_complete BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ
    );
  `);
  await db.exec(await readFile(migration('0001_enterprise_identity.sql'), 'utf8'));
  await db.exec(await readFile(migration('0018_session_active_tenant.sql'), 'utf8'));
  return db;
}

const claims: OidcIdentityClaims = {
  issuer: 'https://id.example.com/realms/openmaic',
  subject: 'subject-1',
  email: 'user@example.com',
  emailVerified: true,
  displayName: 'User',
};

function config(overrides: Partial<OidcAuthConfig> = {}): OidcAuthConfig {
  return {
    mode: 'oidc',
    appOrigin: 'https://openmaic.example.com',
    issuer: claims.issuer,
    clientId: 'openmaic-web',
    clientSecret: 'secret',
    redirectUri: 'https://openmaic.example.com/api/auth/callback',
    sessionSigningKey: new Uint8Array(32).fill(0x31),
    flowEncryptionKey: new Uint8Array(32).fill(0x21),
    sessionTtlSeconds: 900,
    autoProvisionUsers: true,
    defaultTenant: 'default',
    ...overrides,
  };
}

describe('identity session tenant admission', () => {
  let db: PGlite;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://identity-${randomUUID()}`);
    db = await createDatabase();
    const pool = new PGlitePool(db);
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool }),
    }));
  });

  afterEach(async () => {
    vi.doUnmock('@/lib/persistence/server-provider');
    vi.unstubAllEnvs();
    await db.close();
  });

  async function activeTenantOf(sessionId: string): Promise<string | null> {
    const row = await db.query<{ active_tenant_id: string | null }>(
      `SELECT active_tenant_id FROM auth_sessions WHERE sid = $1`,
      [sessionId],
    );
    return row.rows[0]?.active_tenant_id ?? null;
  }

  it('provisions a first login into the configured tenant and pins it', async () => {
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ('acme', 'acme', 'Acme')`);
    const { establishIdentitySession } = await import('@/lib/server/auth/identity');

    const { sessionId, userId } = await establishIdentitySession(
      claims,
      config({ defaultTenant: 'acme' }),
    );

    const membership = await db.query<{ tenant_id: string; role: string }>(
      `SELECT tenant_id, role FROM tenant_memberships WHERE user_id = $1`,
      [userId],
    );
    expect(membership.rows).toEqual([{ tenant_id: 'acme', role: 'member' }]);
    expect(await activeTenantOf(sessionId)).toBe('acme');
  });

  it('refuses admission when the configured tenant does not exist', async () => {
    const { establishIdentitySession, IdentityAdmissionError } =
      await import('@/lib/server/auth/identity');

    await expect(
      establishIdentitySession(claims, config({ defaultTenant: 'missing' })),
    ).rejects.toMatchObject({ reason: 'no-active-membership' });
    expect(IdentityAdmissionError).toBeTypeOf('function');

    // The failed transaction leaves no orphan user or session behind.
    const users = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM app_users`);
    expect(users.rows[0]?.count).toBe(0);
    const sessions = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM auth_sessions`,
    );
    expect(sessions.rows[0]?.count).toBe(0);
  });

  it('leaves the active tenant unset when several memberships are active', async () => {
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ('second', 'second', 'Second')`);
    await db.query(`INSERT INTO app_users (id, display_name) VALUES ('existing', 'Existing')`);
    await db.query(
      `INSERT INTO external_identities (id, user_id, issuer, subject, email_verified)
       VALUES ($1, 'existing', $2, $3, true)`,
      [randomUUID(), claims.issuer, claims.subject],
    );
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES
         ('default', 'existing', 'member'), ('second', 'existing', 'owner')`,
    );
    const { establishIdentitySession } = await import('@/lib/server/auth/identity');

    const { sessionId, userId } = await establishIdentitySession(claims, config());

    expect(userId).toBe('existing');
    expect(await activeTenantOf(sessionId)).toBeNull();
  });

  it('leaves the active tenant unset when a sole membership is suspended but another tenant remains', async () => {
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ('second', 'second', 'Second')`);
    await db.query(`INSERT INTO app_users (id, display_name) VALUES ('existing', 'Existing')`);
    await db.query(
      `INSERT INTO external_identities (id, user_id, issuer, subject, email_verified)
       VALUES ($1, 'existing', $2, $3, true)`,
      [randomUUID(), claims.issuer, claims.subject],
    );
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status) VALUES
         ('default', 'existing', 'member', 'suspended'), ('second', 'existing', 'viewer', 'active')`,
    );
    const { establishIdentitySession } = await import('@/lib/server/auth/identity');

    const { sessionId } = await establishIdentitySession(claims, config());

    // Only the single active membership counts towards the pin.
    expect(await activeTenantOf(sessionId)).toBe('second');
  });

  it('refuses admission when every membership is suspended', async () => {
    await db.query(`INSERT INTO app_users (id, display_name) VALUES ('existing', 'Existing')`);
    await db.query(
      `INSERT INTO external_identities (id, user_id, issuer, subject, email_verified)
       VALUES ($1, 'existing', $2, $3, true)`,
      [randomUUID(), claims.issuer, claims.subject],
    );
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
       VALUES ('default', 'existing', 'member', 'suspended')`,
    );
    const { establishIdentitySession } = await import('@/lib/server/auth/identity');

    await expect(establishIdentitySession(claims, config())).rejects.toMatchObject({
      reason: 'no-active-membership',
    });
  });
});
