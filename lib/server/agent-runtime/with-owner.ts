import { resolveRequestOwnerId } from './owner';
import { resolveAuthConfig, type OpenMaicAuthConfig } from '@/lib/server/auth/config';
import { hasPermission } from '@/lib/server/auth/permissions';
import { clearedSessionCookieHeader, resolveApplicationSession } from '@/lib/server/auth/session';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/server/request-id';
import {
  attributionForOwner,
  runWithUsageAttribution,
  type UsageAttribution,
} from '@/lib/server/usage-attribution';

export type RequestOwnerResolution =
  | { ownerId: string; tenantId?: string; responseHeaders: Headers }
  | { response: Response };

export interface RequestOwnerIdentity {
  ownerId: string;
  tenantId?: string;
}

export interface RequestOwnerOptions {
  /** Permit a handler's explicit, read-only public resource policy for guests. */
  allowAnonymousPublicRead?: (req: Pick<Request, 'headers' | 'method' | 'url'>) => boolean;
  /**
   * Reuse a correlation id already minted by the caller's logging context so a
   * failure log line and its response always agree. When omitted, the boundary
   * adopts the request's `x-request-id` or mints a UUID.
   */
  requestId?: string;
}

/**
 * Resolve an application identity in OIDC mode and preserve anonymous owners in
 * legacy mode, stamping the correlation id on every exit — admitted or rejected.
 */
export async function resolveRequestOwnerIdForRequest(
  req: Pick<Request, 'headers' | 'method' | 'url'>,
  options?: RequestOwnerOptions,
): Promise<RequestOwnerResolution> {
  const requestId = options?.requestId ?? resolveRequestId(req.headers);
  const resolution = await resolveOwnerIdForRequestInner(req, options);
  // Every exit of the owner boundary echoes `x-request-id` — including the
  // 401/403/503 gate rejections that never reach a handler — so a client can
  // always pair a failure with its server log line.
  if ('response' in resolution) {
    resolution.response.headers.set(REQUEST_ID_HEADER, requestId);
    return resolution;
  }
  resolution.responseHeaders.set(REQUEST_ID_HEADER, requestId);
  return resolution;
}

async function resolveOwnerIdForRequestInner(
  req: Pick<Request, 'headers' | 'method' | 'url'>,
  options?: RequestOwnerOptions,
): Promise<RequestOwnerResolution> {
  const responseHeaders = new Headers();
  let config: OpenMaicAuthConfig;
  try {
    config = resolveAuthConfig();
  } catch {
    return {
      response: Response.json(
        { success: false, errorCode: 'AUTH_UNAVAILABLE' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      ),
    };
  }

  if (config.mode === 'legacy') {
    return { ownerId: resolveRequestOwnerId(req, responseHeaders), responseHeaders };
  }

  const session = await resolveApplicationSession(req.headers, config);
  if (session.status === 'authenticated') {
    const method = req.method.toUpperCase();
    // Read-only verbs always pass; a mutating verb needs the write permission.
    // The method gate is load-bearing — checking the permission alone would
    // require every GET to hold `webapp.write` too.
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      !hasPermission(session.session.role, 'webapp.write')
    ) {
      return {
        response: Response.json(
          { success: false, errorCode: 'FORBIDDEN' },
          { status: 403, headers: { 'Cache-Control': 'no-store' } },
        ),
      };
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (req.headers.get('origin') !== config.appOrigin) {
        return {
          response: Response.json(
            { success: false, errorCode: 'INVALID_ORIGIN' },
            { status: 403, headers: { 'Cache-Control': 'no-store' } },
          ),
        };
      }
    }
    return {
      ownerId: `user:${session.session.userId}`,
      tenantId: session.session.tenantId,
      responseHeaders,
    };
  }
  if (session.status === 'tenant-required') {
    // Identity is established but no tenant is chosen, so no tenant-scoped
    // resource can be addressed. 403 (not 401) keeps the client from looping
    // through a login that cannot supply the missing tenant.
    return {
      response: Response.json(
        { success: false, errorCode: 'TENANT_REQUIRED', error: 'tenant_required' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      ),
    };
  }
  if (session.status === 'unavailable') {
    return {
      response: Response.json(
        { success: false, errorCode: 'AUTH_UNAVAILABLE' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      ),
    };
  }

  if (req.method.toUpperCase() === 'GET' && options?.allowAnonymousPublicRead?.(req)) {
    if (session.status === 'invalid') {
      responseHeaders.append('Set-Cookie', clearedSessionCookieHeader());
    }
    return { ownerId: 'public:anonymous', responseHeaders };
  }

  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (session.status === 'invalid') {
    headers.append('Set-Cookie', clearedSessionCookieHeader());
  }
  return {
    response: Response.json(
      { success: false, errorCode: 'LOGIN_REQUIRED', error: 'login_required' },
      { status: 401, headers },
    ),
  };
}

/**
 * Resolve the authenticated or legacy anonymous owner identity and run a
 * handler with its response headers.
 *
 * In legacy mode, the Set-Cookie minted by resolveRequestOwnerId must ride
 * every response, including 4xx and 5xx. In OIDC mode, this boundary resolves
 * and rechecks the database-backed application session on every request.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers' | 'method' | 'url'>,
  handler: (
    ownerId: string,
    responseHeaders: Headers,
    identity?: RequestOwnerIdentity,
  ) => Promise<Response>,
  options?: RequestOwnerOptions,
): Promise<Response> {
  const requestId = options?.requestId ?? resolveRequestId(req.headers);
  const resolution = await resolveRequestOwnerIdForRequest(req, { ...options, requestId });
  if ('response' in resolution) return resolution.response;
  const attribution: UsageAttribution = resolution.tenantId
    ? { ownerId: resolution.ownerId, tenantId: resolution.tenantId }
    : attributionForOwner(resolution.ownerId);
  try {
    return await runWithUsageAttribution(attribution, () =>
      handler(resolution.ownerId, resolution.responseHeaders, {
        ownerId: resolution.ownerId,
        tenantId: resolution.tenantId,
      }),
    );
  } catch (error) {
    console.error(`[agent-runtime] owner-scoped request failed (requestId=${requestId})`, error);
    return new Response('Internal Server Error', {
      status: 500,
      headers: resolution.responseHeaders,
    });
  }
}
