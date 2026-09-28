import { NextRequest, NextResponse } from 'next/server';

import { resolveAuthConfig } from '@/lib/server/auth/config';
import { clearedSessionCookieHeader, resolveApplicationSession } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = resolveAuthConfig();
  } catch {
    return NextResponse.json(
      { mode: 'unavailable', status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (config.mode === 'legacy') {
    return NextResponse.json(
      { mode: 'legacy', status: 'guest' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const resolution = await resolveApplicationSession(request.headers, config);
  if (resolution.status === 'unavailable') {
    return NextResponse.json(
      { mode: 'oidc', status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (resolution.status === 'tenant-required') {
    return NextResponse.json(
      {
        mode: 'oidc',
        status: 'tenant-required',
        userId: resolution.userId,
        expiresAt: resolution.expiresAt,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (resolution.status !== 'authenticated') {
    const response = NextResponse.json(
      { mode: 'oidc', status: 'guest' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    if (resolution.status === 'invalid') {
      response.headers.append('Set-Cookie', clearedSessionCookieHeader());
    }
    return response;
  }

  return NextResponse.json(
    {
      mode: 'oidc',
      status: 'authenticated',
      userId: resolution.session.userId,
      tenantId: resolution.session.tenantId,
      role: resolution.session.role,
      expiresAt: resolution.session.expiresAt,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
