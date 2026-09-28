/**
 * GET /api/stages/[id]/status
 *
 * Returns the public-state metadata for a stage. Used by the Share menu CTA
 * to know whether to show "Publish" or "Already published · Unpublish".
 *
 * Legacy mode preserves the reference's capability read. Owner-read
 * enforcement requires ownership, or a published public course, before
 * disclosing its public-state metadata.
 *
 * Convention: snake_case error codes (e.g. `not_found`, `internal_error`).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { isOwnerReadEnforcementEnabled } from '@/lib/persistence/owner-read-policy';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { resolveStageAccess } from '@/lib/server/stage-access';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  if (!isOwnerReadEnforcementEnabled()) {
    const { id } = await params;
    return readStatus(id, undefined, new Headers());
  }

  return withRequestOwnerId(
    req,
    async (ownerId, responseHeaders) => {
      const { id } = await params;
      return readStatus(id, ownerId, responseHeaders);
    },
    { allowAnonymousPublicRead: () => true },
  );
}

async function readStatus(id: string, ownerId: string | undefined, responseHeaders: Headers) {
  try {
    const access = await resolveStageAccess(id);

    // Tombstoned and never-existed must be indistinguishable.
    if (!access) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
    }
    if (ownerId !== undefined && access.ownerId !== ownerId && !access.isPublic) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
    }

    // Field names are the wire contract; they stay `isPublic` / `publishedAt`
    // regardless of which layer answered.
    return NextResponse.json(
      { isPublic: access.isPublic, publishedAt: access.publishedAt },
      { headers: responseHeaders },
    );
  } catch (error) {
    console.error('Failed to fetch stage status', {
      stageId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500, headers: responseHeaders },
    );
  }
}
