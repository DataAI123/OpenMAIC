import { apiError, type ApiErrorCode } from '@/lib/server/api-response';

import { resolveAuthConfig } from './config';
import { hasPermission, type PermissionKey } from './permissions';
import {
  clearedSessionCookieHeader,
  resolveApplicationSession,
  type AuthenticatedSession,
} from './session';
import { TenantAdminError, type TenantAdminFailure } from './tenant-admin';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/server/request-id';

const READ_ONLY_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** The verified identity a tenant-administration handler acts as. */
export interface TenantAdminContext {
  session: AuthenticatedSession;
  /** Shorthand for `session.tenantId`; a handler never reads a tenant from input. */
  tenantId: string;
  /** Shorthand for `session.userId`; the audit actor and the self-check subject. */
  actorUserId: string;
  actorRole: AuthenticatedSession['role'];
}

function withNoStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

function rawError(errorCode: string, status: number): Response {
  return Response.json({ success: false, errorCode }, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): Headers {
  return new Headers({ 'Cache-Control': 'private, no-store' });
}

const FAILURE_MAP: Record<
  TenantAdminFailure,
  { code: ApiErrorCode; status: number; error: string }
> = {
  'invalid-request': { code: 'INVALID_REQUEST', status: 400, error: 'Invalid request' },
  forbidden: { code: 'FORBIDDEN', status: 403, error: 'Forbidden' },
  'not-found': { code: 'NOT_FOUND', status: 404, error: 'Not found' },
  conflict: { code: 'CONFLICT', status: 409, error: 'Conflict' },
  unavailable: { code: 'INTERNAL_ERROR', status: 503, error: 'Service unavailable' },
};

/**
 * Translate a business refusal raised by the tenant-admin layer into its HTTP
 * response. An unknown user and a subject with no membership in the tenant both
 * surface as `not-found`, so the caller cannot enumerate internal users or probe
 * membership existence.
 */
export function tenantAdminFailure(error: unknown): Response {
  if (error instanceof TenantAdminError) {
    const mapped = FAILURE_MAP[error.reason];
    return withNoStore(apiError(mapped.code, mapped.status, mapped.error));
  }
  return withNoStore(apiError('INTERNAL_ERROR', 500, 'Internal server error'));
}

/**
 * Gate a tenant-administration handler on the authenticated application
 * session and a single permission key.
 *
 * Resolution order matters: configuration, then identity, then permission,
 * then origin. A legacy deployment or an unreachable session store refuses
 * before any permission is consulted, and an unauthenticated caller always
 * learns "log in" rather than whether the tenant exists.
 */
export async function withTenantPermission(
  req: Pick<Request, 'headers' | 'method' | 'url'>,
  key: PermissionKey,
  handler: (context: TenantAdminContext) => Promise<Response>,
): Promise<Response> {
  const requestId = resolveRequestId(req.headers);
  const response = await withTenantPermissionInner(req, key, handler);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

async function withTenantPermissionInner(
  req: Pick<Request, 'headers' | 'method' | 'url'>,
  key: PermissionKey,
  handler: (context: TenantAdminContext) => Promise<Response>,
): Promise<Response> {
  let config;
  try {
    config = resolveAuthConfig();
  } catch {
    return rawError('AUTH_UNAVAILABLE', 503);
  }
  // Legacy mode has no tenant identity to authorize against; leave the
  // enterprise administration surface closed rather than inventing one.
  if (config.mode !== 'oidc') return rawError('AUTH_UNAVAILABLE', 503);

  const session = await resolveApplicationSession(req.headers, config);
  if (session.status === 'unavailable') return rawError('AUTH_UNAVAILABLE', 503);
  // A valid session with no chosen tenant is authenticated but cannot act in a
  // tenant; answer 403 so the client routes to tenant selection instead of
  // looping through a login that cannot supply the missing tenant.
  if (session.status === 'tenant-required') {
    return withNoStore(apiError('TENANT_REQUIRED', 403, 'Tenant selection required'));
  }
  if (session.status !== 'authenticated') {
    const headers = noStoreHeaders();
    if (session.status === 'invalid') headers.append('Set-Cookie', clearedSessionCookieHeader());
    return Response.json(
      { success: false, errorCode: 'LOGIN_REQUIRED', error: 'login_required' },
      { status: 401, headers },
    );
  }

  if (!hasPermission(session.session.role, key)) {
    return withNoStore(apiError('FORBIDDEN', 403, 'Forbidden'));
  }

  if (
    !READ_ONLY_METHODS.includes(req.method.toUpperCase()) &&
    req.headers.get('origin') !== config.appOrigin
  ) {
    return rawError('INVALID_ORIGIN', 403);
  }

  try {
    return withNoStore(
      await handler({
        session: session.session,
        tenantId: session.session.tenantId,
        actorUserId: session.session.userId,
        actorRole: session.session.role,
      }),
    );
  } catch (error) {
    return tenantAdminFailure(error);
  }
}

/** The verified caller of a self-scoped tenant route, tenant choice optional. */
export interface AuthenticatedIdentity {
  userId: string;
  sessionId: string;
  /** Set only when the session has already chosen an active tenant. */
  tenantId: string | null;
  role: AuthenticatedSession['role'] | null;
}

/**
 * Gate a *self-scoped* tenant handler on identity alone — the routes a user
 * calls about their own memberships, which is exactly what a session with no
 * chosen tenant must still be able to reach in order to choose one. No
 * permission key is consulted because no tenant-scoped authority is exercised:
 * the handler may only read rows keyed by `userId`.
 *
 * Resolution order matches `withTenantPermission` (configuration, then identity,
 * then origin) so both surfaces refuse an unreachable store or a legacy
 * deployment before touching data.
 */
export async function withAuthenticatedIdentity(
  req: Pick<Request, 'headers' | 'method'>,
  handler: (identity: AuthenticatedIdentity) => Promise<Response>,
): Promise<Response> {
  const requestId = resolveRequestId(req.headers);
  const response = await withAuthenticatedIdentityInner(req, handler);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

async function withAuthenticatedIdentityInner(
  req: Pick<Request, 'headers' | 'method'>,
  handler: (identity: AuthenticatedIdentity) => Promise<Response>,
): Promise<Response> {
  let config;
  try {
    config = resolveAuthConfig();
  } catch {
    return rawError('AUTH_UNAVAILABLE', 503);
  }
  if (config.mode !== 'oidc') return rawError('AUTH_UNAVAILABLE', 503);

  const session = await resolveApplicationSession(req.headers, config);
  if (session.status === 'unavailable') return rawError('AUTH_UNAVAILABLE', 503);
  if (session.status === 'missing' || session.status === 'invalid') {
    const headers = noStoreHeaders();
    if (session.status === 'invalid') headers.append('Set-Cookie', clearedSessionCookieHeader());
    return Response.json(
      { success: false, errorCode: 'LOGIN_REQUIRED', error: 'login_required' },
      { status: 401, headers },
    );
  }

  if (
    !READ_ONLY_METHODS.includes(req.method.toUpperCase()) &&
    req.headers.get('origin') !== config.appOrigin
  ) {
    return rawError('INVALID_ORIGIN', 403);
  }

  const identity: AuthenticatedIdentity =
    session.status === 'authenticated'
      ? {
          userId: session.session.userId,
          sessionId: session.session.sessionId,
          tenantId: session.session.tenantId,
          role: session.session.role,
        }
      : { userId: session.userId, sessionId: session.sessionId, tenantId: null, role: null };

  try {
    return withNoStore(await handler(identity));
  } catch (error) {
    return tenantAdminFailure(error);
  }
}
