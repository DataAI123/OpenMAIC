/**
 * /api/tenant — the tenants the authenticated caller may act in.
 *
 * Self-scoped: the query is keyed by the verified session's user id, never by
 * input, so this cannot enumerate another user's memberships. It accepts a
 * `tenant-required` session on purpose — a session with no chosen tenant has to
 * be able to read this list in order to choose one via POST /api/tenant/active.
 * Each entry carries the tenant's status so a suspended tenant can be explained
 * rather than silently omitted.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { withAuthenticatedIdentity } from '@/lib/server/auth/authorize';
import { listTenantsForUser } from '@/lib/server/auth/tenant-admin';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  return withAuthenticatedIdentity(req, async ({ userId }) => {
    const tenants = await listTenantsForUser(userId);
    return apiSuccess({ tenants });
  });
}
