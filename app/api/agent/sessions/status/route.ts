import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { stampRequestId } from '@/lib/server/request-id';

export const runtime = 'nodejs';

/** Return a sparse status map for all sessions visible to this owner. */
export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) {
    return stampRequestId(new Response('Not found', { status: 404 }), req.headers);
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders, identity) => {
    const store = await getAgentSessionStore(identity?.tenantId);
    const sessions = await store.listSessionsByOwner(ownerId);
    const statuses = Object.fromEntries(sessions.map((session) => [session.id, session.status]));
    return NextResponse.json(statuses, { headers: responseHeaders });
  });
}
