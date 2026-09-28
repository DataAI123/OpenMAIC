import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import { canAssignRole, canModifyRole, isTenantRole, type TenantRole } from './permissions';

export type TenantMemberStatus = 'active' | 'suspended';
export type TenantRoleAction = 'grant' | 'change' | 'revoke';
export type TenantStatus = 'active' | 'suspended';

/** One tenant the caller is an active member of, as seen by the caller. */
export interface UserTenant {
  tenantId: string;
  slug: string;
  name: string;
  status: TenantStatus;
  role: TenantRole;
}

export interface TenantMember {
  userId: string;
  displayName: string | null;
  role: TenantRole;
  status: TenantMemberStatus;
  createdAt: string;
}

export interface TenantRoleAuditEntry {
  id: string;
  actorUserId: string | null;
  subjectUserId: string;
  action: TenantRoleAction;
  previousRole: TenantRole | null;
  newRole: TenantRole | null;
  source: 'api' | 'cli';
  reason: string | null;
  createdAt: string;
}

export type TenantAdminFailure =
  | 'not-found'
  | 'forbidden'
  | 'conflict'
  | 'invalid-request'
  | 'unavailable';

/**
 * A refusal the HTTP layer can translate into a status code. An unknown or
 * disabled subject and, on removal, a subject with no membership in this tenant
 * both raise `not-found` indistinguishably, so a probe cannot tell a non-member
 * from a non-existent user.
 */
export class TenantAdminError extends Error {
  constructor(readonly reason: TenantAdminFailure) {
    super(`Tenant administration refused (${reason})`);
    this.name = 'TenantAdminError';
  }
}

export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LIMIT = 200;
export const MAX_TENANT_NAME_LENGTH = 200;

/**
 * A display name is free text but never a control channel: it is stored, echoed
 * back, and written to the audit `detail`, so newlines and other control
 * characters are refused rather than normalized.
 */
function normalizeTenantName(value: unknown): string {
  if (typeof value !== 'string') throw new TenantAdminError('invalid-request');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TENANT_NAME_LENGTH) {
    throw new TenantAdminError('invalid-request');
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new TenantAdminError('invalid-request');
  return trimmed;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new TenantAdminError('unavailable');
  let pool;
  try {
    ({ pool } = await getServerPersistenceProvider(connectionString));
  } catch {
    throw new TenantAdminError('unavailable');
  }
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new TenantAdminError('unavailable');
  }
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error instanceof TenantAdminError ? error : new TenantAdminError('unavailable');
  } finally {
    client.release();
  }
}

/**
 * Serializes role mutations per tenant. Row locks on the target membership are
 * not enough for the last-owner rule: two concurrent demotions of two different
 * owners would each see the other owner still present and both commit.
 */
async function lockTenantRoleMutations(client: PoolClient, tenantId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `openmaic-tenant-role:${tenantId}`,
  ]);
}

/**
 * Refuses a change that would leave the tenant without an active owner. Called
 * while the target membership still holds the owner role, so a count of one
 * means the target is that last owner.
 */
async function assertAnotherActiveOwner(client: PoolClient, tenantId: string): Promise<void> {
  const owners = await client.query<{ count: number }>(
    `SELECT COUNT(*)::integer AS count
       FROM tenant_memberships
      WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'`,
    [tenantId],
  );
  if ((owners.rows[0]?.count ?? 0) <= 1) throw new TenantAdminError('conflict');
}

export async function listTenantMembers(tenantId: string): Promise<TenantMember[]> {
  return withClient(async (client) => {
    const result = await client.query<{
      user_id: string;
      display_name: string | null;
      role: TenantRole;
      status: TenantMemberStatus;
      created_at: Date | string;
    }>(
      `SELECT m.user_id, u.display_name, m.role, m.status, m.created_at
         FROM tenant_memberships m
         JOIN app_users u ON u.id = m.user_id
        WHERE m.tenant_id = $1
        ORDER BY m.created_at, m.user_id`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      createdAt: toIso(row.created_at),
    }));
  });
}

export async function assignTenantRole(input: {
  tenantId: string;
  actorUserId: string;
  actorRole: TenantRole;
  subjectUserId: string;
  role: TenantRole;
  reason: string | null;
}): Promise<TenantMember> {
  if (!isTenantRole(input.role)) throw new TenantAdminError('invalid-request');
  return withClient(async (client) => {
    await lockTenantRoleMutations(client, input.tenantId);

    const subject = await client.query<{
      status: string;
      display_name: string | null;
    }>(`SELECT status, display_name FROM app_users WHERE id = $1`, [input.subjectUserId]);
    const subjectRow = subject.rows[0];
    // A disabled or unknown user is not addressable as a member; both answer
    // not-found so the caller cannot enumerate internal users.
    if (!subjectRow || subjectRow.status !== 'active') throw new TenantAdminError('not-found');

    const existing = await client.query<{
      role: TenantRole;
      status: TenantMemberStatus;
      created_at: Date | string;
    }>(
      `SELECT role, status, created_at
         FROM tenant_memberships
        WHERE tenant_id = $1 AND user_id = $2
        FOR UPDATE`,
      [input.tenantId, input.subjectUserId],
    );
    const current = existing.rows[0] ?? null;

    if (current && !canModifyRole(input.actorRole, current.role)) {
      throw new TenantAdminError('forbidden');
    }
    if (!canAssignRole(input.actorRole, input.role)) throw new TenantAdminError('forbidden');
    if (current?.role === 'owner' && input.role !== 'owner') {
      await assertAnotherActiveOwner(client, input.tenantId);
    }

    if (current && current.role === input.role && current.status === 'active') {
      // Idempotent re-assignment: nothing changed, so nothing is audited.
      return {
        userId: input.subjectUserId,
        displayName: subjectRow.display_name,
        role: current.role,
        status: current.status,
        createdAt: toIso(current.created_at),
      };
    }

    const action: TenantRoleAction = current ? 'change' : 'grant';
    const written = current
      ? await client.query<{ created_at: Date | string }>(
          `UPDATE tenant_memberships
              SET role = $3, status = 'active', updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $1 AND user_id = $2
          RETURNING created_at`,
          [input.tenantId, input.subjectUserId, input.role],
        )
      : await client.query<{ created_at: Date | string }>(
          `INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
           VALUES ($1, $2, $3, 'active')
           RETURNING created_at`,
          [input.tenantId, input.subjectUserId, input.role],
        );

    await client.query(
      `INSERT INTO tenant_role_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'api', $8)`,
      [
        randomUUID(),
        input.tenantId,
        input.actorUserId,
        input.subjectUserId,
        action,
        current?.role ?? null,
        input.role,
        input.reason,
      ],
    );

    return {
      userId: input.subjectUserId,
      displayName: subjectRow.display_name,
      role: input.role,
      status: 'active',
      createdAt: toIso(written.rows[0]?.created_at ?? current?.created_at ?? new Date()),
    };
  });
}

export async function revokeTenantMembership(input: {
  tenantId: string;
  actorUserId: string;
  actorRole: TenantRole;
  subjectUserId: string;
  reason: string | null;
}): Promise<{ userId: string; previousRole: TenantRole }> {
  return withClient(async (client) => {
    await lockTenantRoleMutations(client, input.tenantId);

    const existing = await client.query<{ role: TenantRole }>(
      `SELECT role
         FROM tenant_memberships
        WHERE tenant_id = $1 AND user_id = $2
        FOR UPDATE`,
      [input.tenantId, input.subjectUserId],
    );
    const current = existing.rows[0];
    if (!current) throw new TenantAdminError('not-found');
    if (!canModifyRole(input.actorRole, current.role)) throw new TenantAdminError('forbidden');
    if (current.role === 'owner') await assertAnotherActiveOwner(client, input.tenantId);

    await client.query(`DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [
      input.tenantId,
      input.subjectUserId,
    ]);
    await client.query(
      `INSERT INTO tenant_role_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, previous_role, new_role, source, reason)
       VALUES ($1, $2, $3, $4, 'revoke', $5, NULL, 'api', $6)`,
      [
        randomUUID(),
        input.tenantId,
        input.actorUserId,
        input.subjectUserId,
        current.role,
        input.reason,
      ],
    );

    return { userId: input.subjectUserId, previousRole: current.role };
  });
}

/**
 * Re-points a signed session at another tenant the user is an active member of.
 * Membership is re-validated here rather than trusted from the session, so a
 * revoked membership cannot be reached by switching. Answers `not-found` for a
 * tenant the user is not active in, so a probe cannot tell unknown tenants from
 * forbidden ones. A switch to the current tenant is an idempotent no-op and is
 * not audited.
 */
export async function switchActiveTenant(input: {
  sessionId: string;
  userId: string;
  tenantId: string;
}): Promise<{ tenantId: string }> {
  return withClient(async (client) => {
    const membership = await client.query<{ tenant_id: string }>(
      `SELECT m.tenant_id
         FROM tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
        WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.status = 'active'`,
      [input.userId, input.tenantId],
    );
    if (!membership.rows[0]) throw new TenantAdminError('not-found');

    const current = await client.query<{ active_tenant_id: string | null }>(
      `SELECT active_tenant_id
         FROM auth_sessions
        WHERE sid = $1 AND user_id = $2
          AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        FOR UPDATE`,
      [input.sessionId, input.userId],
    );
    const sessionRow = current.rows[0];
    if (!sessionRow) throw new TenantAdminError('not-found');
    if (sessionRow.active_tenant_id === input.tenantId) {
      // Idempotent no-op switch: nothing changed, so nothing is audited.
      return { tenantId: input.tenantId };
    }

    await client.query(
      `UPDATE auth_sessions SET active_tenant_id = $3 WHERE sid = $1 AND user_id = $2`,
      [input.sessionId, input.userId, input.tenantId],
    );
    await client.query(
      `INSERT INTO tenant_admin_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, detail, source)
       VALUES ($1, $2, $3, NULL, 'switch', NULL, 'api')`,
      [randomUUID(), input.tenantId, input.userId],
    );
    return { tenantId: input.tenantId };
  });
}

export async function listTenantRoleAudit(
  tenantId: string,
  limit: number = DEFAULT_AUDIT_LIMIT,
): Promise<TenantRoleAuditEntry[]> {
  const bounded =
    Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, MAX_AUDIT_LIMIT)
      : DEFAULT_AUDIT_LIMIT;
  return withClient(async (client) => {
    const result = await client.query<{
      id: string;
      actor_user_id: string | null;
      subject_user_id: string;
      action: TenantRoleAction;
      previous_role: TenantRole | null;
      new_role: TenantRole | null;
      source: 'api' | 'cli';
      reason: string | null;
      created_at: Date | string;
    }>(
      `SELECT id, actor_user_id, subject_user_id, action, previous_role, new_role,
              source, reason, created_at
         FROM tenant_role_audit
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [tenantId, bounded],
    );
    return result.rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      subjectUserId: row.subject_user_id,
      action: row.action,
      previousRole: row.previous_role,
      newRole: row.new_role,
      source: row.source,
      reason: row.reason,
      createdAt: toIso(row.created_at),
    }));
  });
}

/**
 * The tenants a user may act in, i.e. the ones where they hold an active
 * membership. Deliberately not filtered by tenant status: a suspended tenant is
 * still reported (with its status) so the client can explain why acting in it is
 * refused, instead of showing a tenant list that silently drops entries.
 */
export async function listTenantsForUser(userId: string): Promise<UserTenant[]> {
  return withClient(async (client) => {
    const result = await client.query<{
      tenant_id: string;
      slug: string;
      name: string;
      status: TenantStatus;
      role: TenantRole;
    }>(
      `SELECT t.id AS tenant_id, t.slug, t.name, t.status, m.role
         FROM tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.status = 'active'
        ORDER BY t.name, t.id`,
      [userId],
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      role: row.role,
    }));
  });
}

/**
 * Renames a tenant. A rename to the current name changes nothing, so it is an
 * unaudited no-op — the same rule the role and tenant-switch paths follow, which
 * keeps the audit trail free of rows that record no transition.
 */
export async function renameTenant(input: {
  tenantId: string;
  actorUserId: string;
  name: unknown;
}): Promise<{ tenantId: string; name: string }> {
  const name = normalizeTenantName(input.name);
  return withClient(async (client) => {
    await lockTenantRoleMutations(client, input.tenantId);
    const current = await client.query<{ name: string }>(
      `SELECT name FROM tenants WHERE id = $1 FOR UPDATE`,
      [input.tenantId],
    );
    const row = current.rows[0];
    if (!row) throw new TenantAdminError('not-found');
    if (row.name === name) return { tenantId: input.tenantId, name };

    await client.query(
      `UPDATE tenants SET name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [input.tenantId, name],
    );
    await client.query(
      `INSERT INTO tenant_admin_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, detail, source)
       VALUES ($1, $2, $3, NULL, 'rename', $4, 'api')`,
      [randomUUID(), input.tenantId, input.actorUserId, name],
    );
    return { tenantId: input.tenantId, name };
  });
}

/** One membership's state after a suspend/resume, as the route echoes it back. */
export interface MembershipStatusChange {
  userId: string;
  role: TenantRole;
  status: TenantMemberStatus;
}

/**
 * Toggles one membership's `status` in place — the row is suspended, never
 * deleted, so the role binding and its history survive a suspension.
 *
 * A suspension narrows the active-owner pool, so the last active owner cannot be
 * suspended; a resume only widens it and is always allowed. Setting the status
 * the membership already holds is an unaudited no-op, the same rule the role
 * and tenant switch paths follow.
 */
async function setMembershipStatus(input: {
  tenantId: string;
  actorUserId: string;
  actorRole: TenantRole;
  subjectUserId: string;
  status: TenantMemberStatus;
  reason: string | null;
}): Promise<MembershipStatusChange> {
  if (input.status !== 'active' && input.status !== 'suspended') {
    throw new TenantAdminError('invalid-request');
  }
  return withClient(async (client) => {
    await lockTenantRoleMutations(client, input.tenantId);

    const existing = await client.query<{ role: TenantRole; status: TenantMemberStatus }>(
      `SELECT role, status
         FROM tenant_memberships
        WHERE tenant_id = $1 AND user_id = $2
        FOR UPDATE`,
      [input.tenantId, input.subjectUserId],
    );
    const current = existing.rows[0];
    if (!current) throw new TenantAdminError('not-found');
    if (!canModifyRole(input.actorRole, current.role)) throw new TenantAdminError('forbidden');
    if (current.status === input.status) {
      return { userId: input.subjectUserId, role: current.role, status: current.status };
    }
    if (current.role === 'owner' && input.status === 'suspended') {
      await assertAnotherActiveOwner(client, input.tenantId);
    }

    await client.query(
      `UPDATE tenant_memberships
          SET status = $3, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND user_id = $2`,
      [input.tenantId, input.subjectUserId, input.status],
    );
    await client.query(
      `INSERT INTO tenant_admin_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, detail, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'api')`,
      [
        randomUUID(),
        input.tenantId,
        input.actorUserId,
        input.subjectUserId,
        input.status === 'suspended' ? 'membership_suspend' : 'membership_resume',
        input.reason,
      ],
    );
    return { userId: input.subjectUserId, role: current.role, status: input.status };
  });
}

export async function suspendMembership(input: {
  tenantId: string;
  actorUserId: string;
  actorRole: TenantRole;
  subjectUserId: string;
  reason: string | null;
}): Promise<MembershipStatusChange> {
  return setMembershipStatus({ ...input, status: 'suspended' });
}

export async function resumeMembership(input: {
  tenantId: string;
  actorUserId: string;
  actorRole: TenantRole;
  subjectUserId: string;
  reason: string | null;
}): Promise<MembershipStatusChange> {
  return setMembershipStatus({ ...input, status: 'active' });
}

/**
 * Self-service exit: the caller's own active membership is deleted and every
 * session of theirs pinned to that tenant is un-pinned.
 *
 * Un-pinning matters because a session whose pinned membership disappeared
 * resolves to `invalid` (a genuine authorization failure → re-login). Clearing
 * the pin lands it in `tenant-required` instead, so the caller can immediately
 * pick another tenant through `GET /api/tenant` + `POST /api/tenant/active`.
 *
 * A sole active owner cannot leave: a tenant must keep an owner, so ownership
 * has to be handed over first. A non-member, or a member whose binding is
 * already suspended, answers `not-found` — the same answer an unknown tenant
 * gets, so the route is not a membership oracle.
 */
export async function leaveTenant(input: {
  userId: string;
  tenantId: string;
  reason: string | null;
}): Promise<{ tenantId: string; previousRole: TenantRole }> {
  return withClient(async (client) => {
    await lockTenantRoleMutations(client, input.tenantId);

    const existing = await client.query<{ role: TenantRole }>(
      `SELECT role
         FROM tenant_memberships
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
        FOR UPDATE`,
      [input.tenantId, input.userId],
    );
    const current = existing.rows[0];
    if (!current) throw new TenantAdminError('not-found');
    if (current.role === 'owner') await assertAnotherActiveOwner(client, input.tenantId);

    await client.query('DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [
      input.tenantId,
      input.userId,
    ]);
    await client.query(
      `UPDATE auth_sessions
          SET active_tenant_id = NULL
        WHERE user_id = $1 AND active_tenant_id = $2`,
      [input.userId, input.tenantId],
    );
    await client.query(
      `INSERT INTO tenant_admin_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, detail, source)
       VALUES ($1, $2, $3, $3, 'leave', $4, 'api')`,
      [randomUUID(), input.tenantId, input.userId, input.reason],
    );
    return { tenantId: input.tenantId, previousRole: current.role };
  });
}

/**
 * Suspends or reactivates a tenant. The tenant row is the switch that
 * `resolveApplicationSession` and `switchActiveTenant` both require to be
 * active, so suspending one makes every session pinned to it fail closed
 * (no fallback to another tenant) and blocks new switches into it. Setting the
 * status it already has is an unaudited no-op.
 */
export async function setTenantStatus(input: {
  tenantId: string;
  actorUserId: string;
  status: TenantStatus;
}): Promise<{ tenantId: string; status: TenantStatus }> {
  if (input.status !== 'active' && input.status !== 'suspended') {
    throw new TenantAdminError('invalid-request');
  }
  return withClient(async (client) => {
    await lockTenantRoleMutations(client, input.tenantId);
    const current = await client.query<{ status: TenantStatus }>(
      `SELECT status FROM tenants WHERE id = $1 FOR UPDATE`,
      [input.tenantId],
    );
    const row = current.rows[0];
    if (!row) throw new TenantAdminError('not-found');
    if (row.status === input.status) return { tenantId: input.tenantId, status: row.status };

    await client.query(
      `UPDATE tenants SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [input.tenantId, input.status],
    );
    await client.query(
      `INSERT INTO tenant_admin_audit
         (id, tenant_id, actor_user_id, subject_user_id, action, detail, source)
       VALUES ($1, $2, $3, NULL, $4, NULL, 'api')`,
      [
        randomUUID(),
        input.tenantId,
        input.actorUserId,
        input.status === 'suspended' ? 'suspend' : 'activate',
      ],
    );
    return { tenantId: input.tenantId, status: input.status };
  });
}
