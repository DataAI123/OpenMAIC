/**
 * /api/tenant/active — choose the tenant the current session acts in.
 *
 * This is the one tenant route that accepts a `tenant-required` session: it is
 * how a session that has no active tenant acquires one. It still verifies
 * identity and origin, re-validates the target membership in the store, and
 * audits a real change; switching to the current tenant is a no-op.
 */
import { type NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { resolveAuthConfig, TENANT_ID_PATTERN } from '@/lib/server/auth/config';
import { clearedSessionCookieHeader, resolveApplicationSession } from '@/lib/server/auth/session';
import { switchActiveTenant, TenantAdminError } from '@/lib/server/auth/tenant-admin';
import { tenantAdminFailure } from '@/lib/server/auth/authorize';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/server/request-id';

export const runtime = 'nodejs';

function noStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

function rawError(errorCode: string, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(
    { success: false, errorCode, ...extra },
    { status, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(req.headers);
  const response = await postTenantActive(req);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

async function postTenantActive(req: NextRequest): Promise<Response> {
  let config;
  try {
    config = resolveAuthConfig();
  } catch {
    return rawError('AUTH_UNAVAILABLE', 503);
  }
  if (config.mode !== 'oidc') return rawError('AUTH_UNAVAILABLE', 503);

  const resolution = await resolveApplicationSession(req.headers, config);
  if (resolution.status === 'unavailable') return rawError('AUTH_UNAVAILABLE', 503);
  if (resolution.status === 'missing' || resolution.status === 'invalid') {
    const headers: Record<string, string> = { 'Cache-Control': 'private, no-store' };
    if (resolution.status === 'invalid') headers['Set-Cookie'] = clearedSessionCookieHeader();
    return Response.json(
      { success: false, errorCode: 'LOGIN_REQUIRED', error: 'login_required' },
      { status: 401, headers },
    );
  }

  if (req.headers.get('origin') !== config.appOrigin) {
    return rawError('INVALID_ORIGIN', 403);
  }

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    const parsed: unknown = text.trim() ? JSON.parse(text) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TenantAdminError('invalid-request');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return rawError('INVALID_REQUEST', 400);
  }
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : '';
  if (!TENANT_ID_PATTERN.test(tenantId)) return rawError('INVALID_REQUEST', 400);

  try {
    const switched = await switchActiveTenant({
      sessionId:
        resolution.status === 'authenticated' ? resolution.session.sessionId : resolution.sessionId,
      userId: resolution.status === 'authenticated' ? resolution.session.userId : resolution.userId,
      tenantId,
    });
    return noStore(apiSuccess({ tenantId: switched.tenantId }));
  } catch (error) {
    return tenantAdminFailure(error);
  }
}
