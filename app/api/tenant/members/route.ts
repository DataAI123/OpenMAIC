/**
 * /api/tenant/members — read the authenticated tenant's memberships.
 *
 * The tenant is taken from the verified application session, never from input,
 * so a caller can only ever read their own tenant. Reading requires the
 * `tenant.member.read` permission (owner/admin); a member or viewer is refused
 * with 403 before the store is touched.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { withTenantPermission } from '@/lib/server/auth/authorize';
import { listTenantMembers } from '@/lib/server/auth/tenant-admin';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  return withTenantPermission(req, 'tenant.member.read', async ({ tenantId }) => {
    const members = await listTenantMembers(tenantId);
    return apiSuccess({ members });
  });
}
