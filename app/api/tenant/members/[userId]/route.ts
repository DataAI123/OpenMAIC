/**
 * /api/tenant/members/[userId] — bind, remove or (de)activate one membership.
 *
 * - PUT    binds `{ role, reason? }` to `userId` (grant, change, or reactivate).
 * - PATCH  sets `{ status, reason? }` (suspend or resume without changing role).
 * - DELETE removes the membership (`{ reason? }` optional).
 *
 * All three run behind `tenant.member.manage`, so a member or viewer never
 * reaches the store. The tenant and the acting role come from the verified
 * session; the store re-checks rank, refuses privilege escalation, and protects
 * the last active owner. An unknown or disabled subject answers the same 404 as a
 * removal of a subject with no membership here, so the response is not an
 * enumeration oracle.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { withTenantPermission } from '@/lib/server/auth/authorize';
import { isTenantRole } from '@/lib/server/auth/permissions';
import {
  assignTenantRole,
  resumeMembership,
  revokeTenantMembership,
  suspendMembership,
  TenantAdminError,
  type TenantMemberStatus,
} from '@/lib/server/auth/tenant-admin';

export const runtime = 'nodejs';

const USER_ID_MAX_LENGTH = 256;
const REASON_MAX_LENGTH = 500;

type Params = { params: Promise<{ userId: string }> };

function normalizeUserId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > USER_ID_MAX_LENGTH) {
    throw new TenantAdminError('invalid-request');
  }
  return trimmed;
}

function normalizeReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TenantAdminError('invalid-request');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > REASON_MAX_LENGTH) throw new TenantAdminError('invalid-request');
  return trimmed;
}

/** Parse an optional JSON object body; an empty body is `{}` when optional. */
async function readJsonObject(
  req: NextRequest,
  options: { optional?: boolean } = {},
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new TenantAdminError('invalid-request');
  }
  if (!text.trim()) {
    if (options.optional) return {};
    throw new TenantAdminError('invalid-request');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TenantAdminError('invalid-request');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TenantAdminError('invalid-request');
  }
  return parsed as Record<string, unknown>;
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { userId } = await params;
  return withTenantPermission(req, 'tenant.member.manage', async (context) => {
    const subjectUserId = normalizeUserId(userId);
    const body = await readJsonObject(req);
    if (!isTenantRole(body.role)) throw new TenantAdminError('invalid-request');
    const member = await assignTenantRole({
      tenantId: context.tenantId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      subjectUserId,
      role: body.role,
      reason: normalizeReason(body.reason),
    });
    return apiSuccess({ member });
  });
}

function isMemberStatus(value: unknown): value is TenantMemberStatus {
  return value === 'active' || value === 'suspended';
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { userId } = await params;
  return withTenantPermission(req, 'tenant.member.manage', async (context) => {
    const subjectUserId = normalizeUserId(userId);
    const body = await readJsonObject(req);
    if (!isMemberStatus(body.status)) throw new TenantAdminError('invalid-request');
    const input = {
      tenantId: context.tenantId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      subjectUserId,
      reason: normalizeReason(body.reason),
    };
    const member =
      body.status === 'suspended' ? await suspendMembership(input) : await resumeMembership(input);
    return apiSuccess({ member });
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { userId } = await params;
  return withTenantPermission(req, 'tenant.member.manage', async (context) => {
    const subjectUserId = normalizeUserId(userId);
    const body = await readJsonObject(req, { optional: true });
    const member = await revokeTenantMembership({
      tenantId: context.tenantId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
      subjectUserId,
      reason: normalizeReason(body.reason),
    });
    return apiSuccess({ member });
  });
}
