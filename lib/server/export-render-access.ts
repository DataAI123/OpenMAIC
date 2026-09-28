/**
 * Shared access guard for the export-video by-id render routes (poll, cancel,
 * download). The same owner check gates all three, so this fail-closed logic
 * lives in exactly one place: if ownership cannot be CONFIRMED, refuse.
 *
 * A foreign or unknown (or malformed) job id yields the codebase's plain no-
 * existence-oracle 404, identical to a missing job. Any store outage yields a
 * 503 rather than relaying the request — the routes never fall open on error.
 */
import type { NextResponse } from 'next/server';

import { apiError } from '@/lib/server/api-response';
import { ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { createLogger } from '@/lib/logger';

import { assertRenderJobOwnedBy } from '@/lib/server/export-render-jobs';

const log = createLogger('ExportVideo Access Guard');

/** Ride the owner-scoped response headers (e.g. the anonymous-owner cookie). */
export function attachOwnerHeaders<T extends Response>(response: T, headers: Headers): T {
  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

/**
 * Returns a Response to send immediately (404 not-owned, 503 store unavailable),
 * or `null` when `ownerId` owns `jobId` and the caller may relay to the render
 * service.
 */
export async function guardRenderJobAccess(
  jobId: string,
  ownerId: string,
  responseHeaders: Headers,
): Promise<NextResponse | null> {
  let owned: boolean;
  try {
    owned = await assertRenderJobOwnedBy(jobId, ownerId);
  } catch (error) {
    log.error(`Failed to verify render job ownership [job=${jobId}]:`, error);
    return attachOwnerHeaders(
      apiError('UPSTREAM_ERROR', 503, 'Render job ownership store is unavailable'),
      responseHeaders,
    );
  }
  if (!owned) return ownerNotFound(responseHeaders);
  return null;
}
