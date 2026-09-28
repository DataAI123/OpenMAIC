import { randomUUID } from 'node:crypto';

import type { OidcAuthConfig } from './config';
import { signApplicationSession } from './session';

export interface OidcIdentityClaims {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  idpSessionId?: string;
  authTime?: number;
}

export class IdentityAdmissionError extends Error {
  constructor(readonly reason: 'user-disabled' | 'no-active-membership' | 'identity-mismatch') {
    super(`Identity admission denied (${reason})`);
    this.name = 'IdentityAdmissionError';
  }
}

/**
 * Maps the stable (issuer, subject) pair to an internal user, assigns a first
 * login to the configured default tenant, and persists the signed app session
 * as one short PostgreSQL transaction. Admission requires at least one active
 * membership in an active tenant; the session's active tenant is set only when
 * that choice is unambiguous (exactly one), otherwise the user picks one later.
 */
export async function establishIdentitySession(
  claims: OidcIdentityClaims,
  config: OidcAuthConfig,
): Promise<{ token: string; sessionId: string; userId: string }> {
  if (claims.issuer !== config.issuer || !claims.subject) {
    throw new IdentityAdmissionError('identity-mismatch');
  }
  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const client = await pool.connect();
  const candidateUserId = randomUUID();
  const sessionId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + config.sessionTtlSeconds;

  try {
    await client.query('BEGIN');
    const existingIdentity = await client.query<{ user_id: string }>(
      `SELECT user_id FROM external_identities WHERE issuer = $1 AND subject = $2 FOR UPDATE`,
      [claims.issuer, claims.subject],
    );
    let userId = existingIdentity.rows[0]?.user_id;
    if (userId) {
      await client.query(
        `UPDATE external_identities
            SET email_snapshot = $3, email_verified = $4
          WHERE issuer = $1 AND subject = $2`,
        [claims.issuer, claims.subject, claims.email ?? null, claims.emailVerified],
      );
    } else {
      if (!config.autoProvisionUsers) throw new IdentityAdmissionError('no-active-membership');
      await client.query(`INSERT INTO app_users (id, display_name) VALUES ($1, $2)`, [
        candidateUserId,
        claims.displayName ?? null,
      ]);
      const identity = await client.query<{ user_id: string }>(
        `INSERT INTO external_identities
           (id, user_id, issuer, subject, email_snapshot, email_verified)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (issuer, subject) DO UPDATE
           SET email_snapshot = EXCLUDED.email_snapshot,
               email_verified = EXCLUDED.email_verified
         RETURNING user_id`,
        [
          randomUUID(),
          candidateUserId,
          claims.issuer,
          claims.subject,
          claims.email ?? null,
          claims.emailVerified,
        ],
      );
      userId = identity.rows[0]?.user_id;
      if (!userId) throw new Error('Identity mapping did not return an internal user');
      if (userId !== candidateUserId) {
        await client.query('DELETE FROM app_users WHERE id = $1', [candidateUserId]);
      }
      await client.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role)
         SELECT $1, $2, 'member'
           FROM tenants
          WHERE id = $1 AND status = 'active'
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [config.defaultTenant, userId],
      );
    }
    const userState = await client.query<{ user_status: string }>(
      `SELECT status AS user_status FROM app_users WHERE id = $1`,
      [userId],
    );
    if (userState.rows[0]?.user_status !== 'active') {
      throw new IdentityAdmissionError('user-disabled');
    }
    // Admission needs any active membership in an active tenant; the active
    // tenant is only pinned when the choice is unambiguous.
    const activeTenants = await client.query<{ tenant_id: string }>(
      `SELECT m.tenant_id
         FROM tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
        WHERE m.user_id = $1 AND m.status = 'active'
        ORDER BY m.tenant_id`,
      [userId],
    );
    if (activeTenants.rows.length === 0) {
      throw new IdentityAdmissionError('no-active-membership');
    }
    const activeTenantId = activeTenants.rows.length === 1 ? activeTenants.rows[0].tenant_id : null;

    const token = await signApplicationSession({ userId, sessionId, issuedAt }, config);
    await client.query(
      `INSERT INTO auth_sessions
         (sid, user_id, issuer, idp_sid, auth_time, expires_at, active_tenant_id)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6), $7)`,
      [
        sessionId,
        userId,
        claims.issuer,
        claims.idpSessionId ?? null,
        claims.authTime === undefined ? null : new Date(claims.authTime * 1000),
        expiresAt,
        activeTenantId,
      ],
    );
    await client.query('COMMIT');
    return { token, sessionId, userId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
