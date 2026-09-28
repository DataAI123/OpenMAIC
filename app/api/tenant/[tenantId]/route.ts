/**
 * /api/tenant/[tenantId] — rename, suspend or reactivate a tenant.
 *
 * PATCH body holds exactly one change: `{ name }` or `{ status }`.
 *
 * The path tenant must be the tenant the verified session is already acting in:
 * anything else answers the same 404 as an unknown tenant, so the route is not a
 * tenant-existence oracle and a caller can never administer a tenant they are
 * not currently in. The `tenant.settings.manage` gate is owner-only, so an admin
 * — who may manage members — is refused before the store is touched.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { withTenantPermission } from '@/lib/server/auth/authorize';
import { TENANT_ID_PATTERN } from '@/lib/server/auth/config';
import {
  renameTenant,
  setTenantStatus,
  TenantAdminError,
  type TenantStatus,
} from '@/lib/server/auth/tenant-admin';

export const runtime = 'nodejs';

type Params = { params: Promise<{ tenantId: string }> };

function isTenantStatus(value: unknown): value is TenantStatus {
  return value === 'active' || value === 'suspended';
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { tenantId } = await params;
  return withTenantPermission(req, 'tenant.settings.manage', async (context) => {
    if (!TENANT_ID_PATTERN.test(tenantId) || tenantId !== context.tenantId) {
      throw new TenantAdminError('not-found');
    }

    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      const parsed: unknown = text.trim() ? JSON.parse(text) : null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TenantAdminError('invalid-request');
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      throw error instanceof TenantAdminError ? error : new TenantAdminError('invalid-request');
    }

    const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
    // One change per request: a combined rename+suspend would need two audit
    // rows and two idempotency decisions crammed into one response.
    if (hasName === hasStatus) throw new TenantAdminError('invalid-request');

    if (hasName) {
      const renamed = await renameTenant({
        tenantId: context.tenantId,
        actorUserId: context.actorUserId,
        name: body.name,
      });
      return apiSuccess({ tenant: { tenantId: renamed.tenantId, name: renamed.name } });
    }

    if (!isTenantStatus(body.status)) throw new TenantAdminError('invalid-request');
    const changed = await setTenantStatus({
      tenantId: context.tenantId,
      actorUserId: context.actorUserId,
      status: body.status,
    });
    return apiSuccess({ tenant: { tenantId: changed.tenantId, status: changed.status } });
  });
}
