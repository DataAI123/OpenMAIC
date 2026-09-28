import { NextRequest } from 'next/server';

import { settleWhiteboardVisibility } from '@/lib/chat/pi/whiteboard-visibility';
import { authenticatePersistenceHeaders } from '@/lib/persistence/server-auth';
import { apiError } from '@/lib/server/api-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';

export const runtime = 'nodejs';

const BODY_KEYS = new Set(['queryId', 'stageId', 'visibility']);

function validBody(value: unknown): value is {
  queryId: string;
  stageId: string;
  visibility: 'open' | 'closed';
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Reflect.ownKeys(body).every((key) => typeof key === 'string' && BODY_KEYS.has(key)) &&
    Object.hasOwn(body, 'queryId') &&
    Object.hasOwn(body, 'stageId') &&
    Object.hasOwn(body, 'visibility') &&
    typeof body.queryId === 'string' &&
    body.queryId.length > 0 &&
    typeof body.stageId === 'string' &&
    body.stageId.length > 0 &&
    (body.visibility === 'open' || body.visibility === 'closed')
  );
}

/**
 * Child callback of `/chat/pi`: the server-side director loop dispatches a
 * whiteboard visibility query to the browser and awaits the answer in a
 * process-local map keyed by learner key. Two independent gates must both
 * pass: the application-session owner boundary (middleware admits only an
 * authenticated session; this Node boundary rechecks the database session,
 * viewer and Origin) and the persistence principal that owns the pending
 * query. Settling requires the exact learner key that dispatched it, so a
 * logged-in caller still cannot resolve another principal's query. The route
 * carries no provider cost — the answer is consumed from in-process memory.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return withRequestOwnerId(req, async (_ownerId, responseHeaders) => {
    const fail = (status: number, error: string) =>
      withOwnerResponseHeaders(apiError('INVALID_CREDENTIALS', status, error), responseHeaders);
    const invalid = () =>
      withOwnerResponseHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid whiteboard visibility response'),
        responseHeaders,
      );

    const principal = authenticatePersistenceHeaders(req.headers);
    if (!principal?.learnerKey) {
      return fail(401, 'Invalid persistence development binding');
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return invalid();
    }
    if (!validBody(body)) {
      return invalid();
    }

    if (
      !settleWhiteboardVisibility({
        ...body,
        learnerKey: principal.learnerKey,
      })
    ) {
      return withOwnerResponseHeaders(
        apiError('INVALID_REQUEST', 404, 'Whiteboard visibility query is not pending here'),
        responseHeaders,
      );
    }
    return new Response(null, { status: 204, headers: responseHeaders });
  });
}
