/**
 * /api/tenant/audit — read the authenticated tenant's role-change audit trail.
 *
 * The tenant is taken from the verified application session, never from input.
 * Reading requires `tenant.audit.read` (owner/admin); a member or viewer is
 * refused with 403. `?limit=` is bounded by the store, so a caller cannot ask
 * for an unbounded scan.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { withTenantPermission } from '@/lib/server/auth/authorize';
import { listTenantRoleAudit } from '@/lib/server/auth/tenant-admin';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  return withTenantPermission(req, 'tenant.audit.read', async ({ tenantId }) => {
    const raw = req.nextUrl.searchParams.get('limit');
    const limit = raw === null ? undefined : Number(raw);
    const entries = await listTenantRoleAudit(tenantId, limit);
    return apiSuccess({ entries });
  });
}
