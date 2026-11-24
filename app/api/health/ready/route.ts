import { NextResponse } from 'next/server';

import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/server/request-id';
import { getReadinessOutcome } from '@/lib/server/health-readiness';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const outcome = await getReadinessOutcome();
  const ready = outcome === 'ready';
  const response = NextResponse.json(
    ready ? { success: true, status: 'ok' } : { success: false, status: 'unavailable' },
    { status: ready ? 200 : 503 },
  );
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set(REQUEST_ID_HEADER, resolveRequestId(request.headers));
  return response;
}
