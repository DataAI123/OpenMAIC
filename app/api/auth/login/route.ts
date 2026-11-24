import * as oidc from 'openid-client';
import { NextRequest, NextResponse } from 'next/server';

import { resolveAuthConfig } from '@/lib/server/auth/config';
import { stampRequestId } from '@/lib/server/request-id';
import {
  countFlowCookies,
  oidcFlowLimits,
  sealOidcFlowState,
  serializeFlowCookie,
} from '@/lib/server/auth/flow-state';
import { getOidcClient } from '@/lib/server/auth/oidc-client';
import { safeReturnTo } from '@/lib/server/auth/return-to';

export const runtime = 'nodejs';

function errorResponse(status: number, code: string): NextResponse {
  return NextResponse.json(
    { success: false, errorCode: code },
    { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
}

async function handleGet(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = resolveAuthConfig();
  } catch {
    return errorResponse(503, 'AUTH_UNAVAILABLE');
  }
  if (config.mode !== 'oidc') return errorResponse(404, 'AUTH_DISABLED');
  if (countFlowCookies(request.headers) >= oidcFlowLimits.maxParallelFlows) {
    return errorResponse(429, 'TOO_MANY_LOGIN_FLOWS');
  }

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const flow = {
    state,
    nonce,
    codeVerifier,
    returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo'), config.appOrigin),
    issuedAt: Math.floor(Date.now() / 1000),
  };

  try {
    const client = await getOidcClient(config);
    const authorizationUrl = oidc.buildAuthorizationUrl(client, {
      redirect_uri: config.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const encryptedFlow = await sealOidcFlowState(flow, config);
    const response = NextResponse.redirect(authorizationUrl, { status: 303 });
    response.headers.append('Set-Cookie', serializeFlowCookie(state, encryptedFlow));
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  } catch (error) {
    console.error(
      '[auth] OIDC login preparation failed',
      error instanceof Error ? error.name : 'unknown',
    );
    return errorResponse(503, 'AUTH_UNAVAILABLE');
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    return stampRequestId(await handleGet(request), request.headers);
  } catch (error) {
    console.error(
      '[auth] OIDC login route failed',
      error instanceof Error ? error.name : 'unknown',
    );
    return stampRequestId(errorResponse(503, 'AUTH_UNAVAILABLE'), request.headers);
  }
}
