import { NextRequest, NextResponse } from 'next/server';

import { resolveAuthConfig } from '@/lib/server/auth/config';
import { clearedSessionCookieHeader, resolveApplicationSession } from '@/lib/server/auth/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  let config;
  try {
    config = resolveAuthConfig();
  } catch {
    return NextResponse.json(
      { success: false, errorCode: 'AUTH_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (config.mode === 'legacy') {
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.headers.get('origin') !== config.appOrigin) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_ORIGIN' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const resolution = await resolveApplicationSession(request.headers, config);
  if (resolution.status === 'unavailable') {
    return NextResponse.json(
      { success: false, errorCode: 'AUTH_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const sessionId =
      resolution.status === 'authenticated'
        ? resolution.session.sessionId
        : resolution.status === 'tenant-required'
          ? resolution.sessionId
          : null;
    if (sessionId) {
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      await pool.query(
        `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
          WHERE sid = $1 AND revoked_at IS NULL`,
        [sessionId],
      );
    }
  } catch {
    return NextResponse.json(
      { success: false, errorCode: 'AUTH_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return new NextResponse(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
      'Set-Cookie': clearedSessionCookieHeader(),
    },
  });
}
