/**
 * POST /api/tenant/leave — the caller exits one of their own tenants.
 *
 * Body: `{ tenantId, reason? }`.
 *
 * This is the one tenant-membership action that is deliberately *self-scoped*
 * rather than permission-gated: it runs behind `withAuthenticatedIdentity`, so a
 * caller can only ever act on themselves (`userId` comes from the verified
 * session, never the body). It therefore accepts a `tenant-required` session
 * too — a user whose only membership is the one they are leaving must be able to
 * reach this route before they have a chosen tenant.
 *
 * The store refuses a sole active owner (`conflict`), answers `not-found` for a
 * tenant the caller is not an active member of, and un-pins the caller's
 * sessions so the next request lands in tenant selection rather than a forced
 * re-login.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { withAuthenticatedIdentity } from '@/lib/server/auth/authorize';
import { TENANT_ID_PATTERN } from '@/lib/server/auth/config';
import { leaveTenant, TenantAdminError } from '@/lib/server/auth/tenant-admin';

export const runtime = 'nodejs';

const REASON_MAX_LENGTH = 500;

function normalizeTenantId(value: unknown): string {
  if (typeof value !== 'string') throw new TenantAdminError('invalid-request');
  const trimmed = value.trim();
  if (!TENANT_ID_PATTERN.test(trimmed)) throw new TenantAdminError('invalid-request');
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

async function readJsonObject(req: NextRequest): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new TenantAdminError('invalid-request');
  }
  if (!text.trim()) throw new TenantAdminError('invalid-request');
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

export async function POST(req: NextRequest) {
  return withAuthenticatedIdentity(req, async ({ userId }) => {
    const body = await readJsonObject(req);
    const left = await leaveTenant({
      userId,
      tenantId: normalizeTenantId(body.tenantId),
      reason: normalizeReason(body.reason),
    });
    return apiSuccess({ tenantId: left.tenantId, previousRole: left.previousRole });
  });
}
