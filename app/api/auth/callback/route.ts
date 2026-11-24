import * as oidc from 'openid-client';
import { NextRequest, NextResponse } from 'next/server';

import { resolveAuthConfig } from '@/lib/server/auth/config';
import { stampRequestId } from '@/lib/server/request-id';
import {
  clearFlowCookieHeader,
  openOidcFlowState,
  readFlowCookie,
} from '@/lib/server/auth/flow-state';
import { establishIdentitySession, IdentityAdmissionError } from '@/lib/server/auth/identity';
import { getOidcClient } from '@/lib/server/auth/oidc-client';
import { safeReturnTo } from '@/lib/server/auth/return-to';
import { sessionCookieHeader } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

function response(status: number, code: string): NextResponse {
  return NextResponse.json(
    { success: false, errorCode: code },
    { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
}

function callbackUrl(redirectUri: string, search: string): URL {
  const url = new URL(redirectUri);
  url.search = search;
  return url;
}

function withFlowCookieCleared(result: NextResponse, state: string): NextResponse {
  result.headers.append('Set-Cookie', clearFlowCookieHeader(state));
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  return result;
}

function redirectWithAuthResult(returnTo: string, appOrigin: string, result: string): NextResponse {
  const url = new URL(returnTo, appOrigin);
  url.searchParams.set('auth', result);
  return NextResponse.redirect(url, { status: 303 });
}

async function handleGet(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = resolveAuthConfig();
  } catch {
    return response(503, 'AUTH_UNAVAILABLE');
  }
  if (config.mode !== 'oidc') return response(404, 'AUTH_DISABLED');

  const states = request.nextUrl.searchParams.getAll('state');
  const state = states.length === 1 ? states[0] : undefined;
  if (!state) return response(400, 'INVALID_AUTH_RESPONSE');

  const encryptedFlow = readFlowCookie(request.headers, state);
  if (!encryptedFlow) return response(400, 'LOGIN_FLOW_EXPIRED');

  let flow;
  try {
    flow = await openOidcFlowState(encryptedFlow, config, state);
  } catch {
    return withFlowCookieCleared(response(400, 'INVALID_AUTH_RESPONSE'), state);
  }

  const providerError = request.nextUrl.searchParams.getAll('error');
  const codes = request.nextUrl.searchParams.getAll('code');
  if (
    providerError.length > 1 ||
    (providerError.length === 1 && (!providerError[0] || codes.length > 0))
  ) {
    return withFlowCookieCleared(response(400, 'INVALID_AUTH_RESPONSE'), state);
  }
  if (providerError.length === 1) {
    const denied = providerError[0] === 'access_denied';
    const result = redirectWithAuthResult(
      flow.returnTo,
      config.appOrigin,
      denied ? 'denied' : 'failed',
    );
    return withFlowCookieCleared(result, state);
  }

  if (codes.length !== 1 || !codes[0]) {
    return withFlowCookieCleared(response(400, 'INVALID_AUTH_RESPONSE'), state);
  }

  try {
    const client = await getOidcClient(config);
    const tokenSet = await oidc.authorizationCodeGrant(
      client,
      callbackUrl(config.redirectUri, request.nextUrl.search),
      {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokenSet.claims();
    if (!claims || claims.iss !== config.issuer || typeof claims.sub !== 'string' || !claims.sub) {
      return withFlowCookieCleared(response(401, 'INVALID_IDENTITY'), state);
    }

    const identity = await establishIdentitySession(
      {
        issuer: claims.iss,
        subject: claims.sub,
        ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
        emailVerified: claims.email_verified === true,
        ...(typeof claims.name === 'string'
          ? { displayName: claims.name }
          : typeof claims.preferred_username === 'string'
            ? { displayName: claims.preferred_username }
            : {}),
        ...(typeof claims.sid === 'string' ? { idpSessionId: claims.sid } : {}),
        ...(typeof claims.auth_time === 'number' ? { authTime: claims.auth_time } : {}),
      },
      config,
    );

    const result = NextResponse.redirect(new URL(flow.returnTo, config.appOrigin), { status: 303 });
    result.headers.append(
      'Set-Cookie',
      sessionCookieHeader(identity.token, config.sessionTtlSeconds),
    );
    return withFlowCookieCleared(result, state);
  } catch (error) {
    if (error instanceof IdentityAdmissionError) {
      return withFlowCookieCleared(response(403, 'LOGIN_NOT_AUTHORIZED'), state);
    }
    console.error('[auth] OIDC callback failed', error instanceof Error ? error.name : 'unknown');
    const returnTo = safeReturnTo(flow.returnTo, config.appOrigin);
    return withFlowCookieCleared(
      redirectWithAuthResult(returnTo, config.appOrigin, 'unavailable'),
      state,
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    return stampRequestId(await handleGet(request), request.headers);
  } catch (error) {
    console.error(
      '[auth] OIDC callback route failed',
      error instanceof Error ? error.name : 'unknown',
    );
    return stampRequestId(response(503, 'AUTH_UNAVAILABLE'), request.headers);
  }
}
