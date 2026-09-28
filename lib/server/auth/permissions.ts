import type { AuthenticatedSession } from './session';

/**
 * The tenant roles already recorded by `tenant_memberships.role` (migration
 * 0001). Reusing the session's own union keeps this catalog and the session
 * resolution from drifting apart: a new role added to one is a type error here.
 */
export type TenantRole = AuthenticatedSession['role'];

export const TENANT_ROLES: readonly TenantRole[] = ['owner', 'admin', 'member', 'viewer'];

/**
 * Every authorization action the application performs, in one place. A handler
 * that gates on a role must name one of these keys, so the role matrix — not a
 * scattered `role === '…'` comparison — is the single source of truth.
 */
export const PERMISSION_KEYS = [
  'tenant.member.read',
  'tenant.member.manage',
  'tenant.audit.read',
  'tenant.settings.manage',
  'webapp.write',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSIONS: Record<PermissionKey, string> = {
  'tenant.member.read': '查看本租户成员及其角色',
  'tenant.member.manage': '授予、变更或移除本租户成员的角色',
  'tenant.audit.read': '查看本租户角色变更审计',
  'tenant.settings.manage': '改名、停用或启用本租户',
  'webapp.write': '执行非只读业务操作（写入、生成、导出等）',
};

/**
 * The role→permission matrix. `viewer` holds no write permission; `member` may
 * write business resources but not administer the tenant; `admin` administers
 * members; `owner` holds every permission.
 *
 * This lives in code, not in a database table: permission *actions* are a code
 * contract, and a DB-backed matrix would need cache invalidation and would
 * silently downgrade a role to "no permissions" when its rows are missing.
 * Role *binding* still lives in the database (`tenant_memberships.role`), which
 * is what makes an assignment change take effect on the next request.
 */
const ROLE_PERMISSIONS: Record<TenantRole, readonly PermissionKey[]> = {
  owner: [...PERMISSION_KEYS],
  admin: ['tenant.member.read', 'tenant.member.manage', 'tenant.audit.read', 'webapp.write'],
  member: ['webapp.write'],
  viewer: [],
};

const ROLE_RANK: Record<TenantRole, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && (TENANT_ROLES as readonly string[]).includes(value);
}

/**
 * Whether a role holds a permission. An unrecognized role is denied, so a
 * malformed or legacy session value fails closed instead of inheriting access.
 */
export function hasPermission(role: TenantRole, key: PermissionKey): boolean {
  if (!isTenantRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(key);
}

/** Total order over roles, used to forbid privilege escalation by assignment. */
export function roleRank(role: TenantRole): number {
  return isTenantRole(role) ? ROLE_RANK[role] : -1;
}

/**
 * Whether `actor` may bind `target` as a member's role. An actor may only grant
 * a role strictly below their own; `owner` is the one exception, because a
 * tenant must be able to appoint another owner.
 */
export function canAssignRole(actor: TenantRole, target: TenantRole): boolean {
  if (!isTenantRole(actor) || !isTenantRole(target)) return false;
  return actor === 'owner' || roleRank(actor) > roleRank(target);
}

/**
 * Whether `actor` may change or revoke a membership that currently holds
 * `current`. Same rank rule as assignment: an admin cannot demote or remove
 * another admin, and nobody but an owner can touch an owner.
 */
export function canModifyRole(actor: TenantRole, current: TenantRole): boolean {
  return canAssignRole(actor, current);
}
