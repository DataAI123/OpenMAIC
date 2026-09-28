import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

import type { OidcAuthConfig } from './config';

const SESSION_COOKIE = 'openmaic_session';
const SESSION_TYPE = 'openmaic-session+jwt';

export interface AuthenticatedSession {
  userId: string;
  sessionId: string;
  tenantId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  expiresAt: number;
}

export type SessionResolution =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'unavailable' }
  | { status: 'authenticated'; session: AuthenticatedSession }
  /**
   * The signed session is valid but the user has not chosen an active tenant —
   * either a brand-new identity with no membership, or one whose memberships
   * predate tenant selection. This is distinct from `invalid` on purpose: an
   * `invalid` session triggers a fresh login, which would loop forever because
   * logging in cannot invent a tenant. Consumers answer with 403 TENANT_REQUIRED
   * so the client can route the user to tenant selection.
   */
  | { status: 'tenant-required'; userId: string; sessionId: string; expiresAt: number };

export function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

export function sessionCookieHeader(token: string, ttlSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return (
    `${sessionCookieName()}=${token}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${ttlSeconds}${secure}`
  );
}

export function clearedSessionCookieHeader(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function readSessionCookie(headers: Headers): string | null {
  const raw = headers.get('cookie');
  if (!raw || raw.length > 16_384) return null;
  const matches: string[] = [];
  for (const entry of raw.split(';')) {
    const separator = entry.indexOf('=');
    if (separator > 0 && entry.slice(0, separator).trim() === sessionCookieName()) {
      matches.push(entry.slice(separator + 1).trim());
    }
  }
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

export async function signApplicationSession(
  input: { userId: string; sessionId: string; issuedAt: number },
  config: OidcAuthConfig,
): Promise<string> {
  return new SignJWT({ token_use: 'app_session', version: 1, sid: input.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: SESSION_TYPE, kid: 'v1' })
    .setIssuer(config.appOrigin)
    .setAudience(config.clientId)
    .setSubject(input.userId)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.issuedAt + config.sessionTtlSeconds)
    .setJti(randomUUID())
    .sign(config.sessionSigningKey);
}

export async function resolveApplicationSession(
  headers: Headers,
  config: OidcAuthConfig,
): Promise<SessionResolution> {
  const token = readSessionCookie(headers);
  if (!token)
    return headers.get('cookie')?.includes(`${sessionCookieName()}=`)
      ? { status: 'invalid' }
      : { status: 'missing' };

  let userId: string;
  let sessionId: string;
  let expiresAt: number;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, config.sessionSigningKey, {
      algorithms: ['HS256'],
      issuer: config.appOrigin,
      audience: config.clientId,
      typ: SESSION_TYPE,
      maxTokenAge: config.sessionTtlSeconds,
      clockTolerance: 0,
      requiredClaims: ['sub', 'sid', 'iat', 'exp', 'jti'],
    });
    if (
      protectedHeader.kid !== 'v1' ||
      payload.token_use !== 'app_session' ||
      payload.version !== 1 ||
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return { status: 'invalid' };
    }
    userId = payload.sub;
    sessionId = payload.sid;
    expiresAt = payload.exp;
  } catch {
    return { status: 'invalid' };
  }

  try {
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const result = await pool.query<{
      user_id: string;
      issuer: string;
      expires_at: Date | string;
      revoked_at: Date | string | null;
      user_status: string;
      active_tenant_id: string | null;
      tenant_id: string | null;
      tenant_status: string | null;
      role: AuthenticatedSession['role'] | null;
    }>(
      `SELECT s.user_id, s.issuer, s.expires_at, s.revoked_at,
              u.status AS user_status, s.active_tenant_id,
              m.tenant_id, m.role, t.status AS tenant_status
         FROM auth_sessions s
         JOIN app_users u ON u.id = s.user_id
         LEFT JOIN tenant_memberships m
           ON m.user_id = u.id AND m.status = 'active' AND m.tenant_id = s.active_tenant_id
         LEFT JOIN tenants t ON t.id = m.tenant_id
        WHERE s.sid = $1 AND s.user_id = $2
          AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
          AND s.issuer = $3
        LIMIT 1`,
      [sessionId, userId, config.issuer],
    );
    const row = result.rows[0];
    if (!row || row.user_status !== 'active') return { status: 'invalid' };
    const databaseExpiry = new Date(row.expires_at).getTime() / 1000;
    if (!Number.isFinite(databaseExpiry) || databaseExpiry !== expiresAt)
      return { status: 'invalid' };
    // A session that never selected a tenant is not a broken session; it just
    // needs a tenant choice before any tenant-scoped route can serve it.
    if (row.active_tenant_id === null) {
      return { status: 'tenant-required', userId, sessionId, expiresAt };
    }
    // A selected tenant whose membership was revoked, or whose tenant was
    // suspended, is a genuine authorization failure.
    if (!row.tenant_id || row.tenant_status !== 'active' || !row.role) return { status: 'invalid' };
    return {
      status: 'authenticated',
      session: {
        userId,
        sessionId,
        tenantId: row.tenant_id,
        role: row.role,
        expiresAt,
      },
    };
  } catch {
    return { status: 'unavailable' };
  }
}
