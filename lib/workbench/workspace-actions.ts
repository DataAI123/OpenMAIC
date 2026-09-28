'use server';

import { cookies, headers } from 'next/headers';
import { anonymousCookieSecure } from '@/lib/server/agent-runtime/owner';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { resolveAuthConfig } from '@/lib/server/auth/config';
import { hasPermission } from '@/lib/server/auth/permissions';
import { resolveApplicationSession } from '@/lib/server/auth/session';

/**
 * Legacy anonymous identity handling for Server Actions. OIDC actions instead
 * resolve the database-backed application session below. A Server Action has
 * no `Request` to hand to `resolveRequestOwnerId`, so legacy mode re-reads the
 * same cookie as the routes and mints the same UUID-v4 scheme when it is
 * absent or forged.
 */
const ANONYMOUS_COOKIE = 'anonymous_id';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function currentIdentity(): Promise<{ ownerId: string; tenantId?: string }> {
  const authConfig = resolveAuthConfig();
  if (authConfig.mode === 'oidc') {
    const requestHeaders = await headers();
    if (requestHeaders.get('origin') !== authConfig.appOrigin) throw new Error('INVALID_ORIGIN');
    const session = await resolveApplicationSession(requestHeaders, authConfig);
    if (session.status === 'authenticated') {
      // This action is a mutation, so it needs the write permission rather than
      // the read-only access every authenticated role already has.
      if (!hasPermission(session.session.role, 'webapp.write')) throw new Error('FORBIDDEN');
      return { ownerId: `user:${session.session.userId}`, tenantId: session.session.tenantId };
    }
    throw new Error(
      session.status === 'unavailable'
        ? 'AUTH_UNAVAILABLE'
        : session.status === 'tenant-required'
          ? 'TENANT_REQUIRED'
          : 'LOGIN_REQUIRED',
    );
  }

  const cookieStore = await cookies();
  const existing = cookieStore.get(ANONYMOUS_COOKIE)?.value;
  if (existing && UUID_V4.test(existing)) return { ownerId: `anon:${existing}` };
  const minted = crypto.randomUUID();
  cookieStore.set(ANONYMOUS_COOKIE, minted, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
    secure: anonymousCookieSecure(),
  });
  return { ownerId: `anon:${minted}` };
}

/** Server Action mutation used by the workspace row menu. */
export async function deleteWorkspaceSession(id: string): Promise<{ deleted: boolean }> {
  const { ownerId, tenantId } = await currentIdentity();
  if (typeof id !== 'string') return { deleted: false };
  const sessionId = id.trim();
  if (!sessionId || sessionId.length > 256) return { deleted: false };
  const store = await getAgentSessionStore(tenantId);
  return { deleted: await store.softDeleteSession(sessionId, ownerId) };
}
