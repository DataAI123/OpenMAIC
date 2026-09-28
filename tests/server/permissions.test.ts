import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  PERMISSION_KEYS,
  TENANT_ROLES,
  canAssignRole,
  canModifyRole,
  hasPermission,
  isTenantRole,
  roleRank,
  type PermissionKey,
  type TenantRole,
} from '@/lib/server/auth/permissions';

const EXPECTED_MATRIX: Record<TenantRole, readonly PermissionKey[]> = {
  owner: [
    'tenant.member.read',
    'tenant.member.manage',
    'tenant.audit.read',
    'tenant.settings.manage',
    'webapp.write',
  ],
  admin: ['tenant.member.read', 'tenant.member.manage', 'tenant.audit.read', 'webapp.write'],
  member: ['webapp.write'],
  viewer: [],
};

describe('tenant role permission matrix', () => {
  it('declares exactly the four roles recorded by tenant_memberships.role', () => {
    expect([...TENANT_ROLES].sort()).toEqual(['admin', 'member', 'owner', 'viewer']);
    for (const role of TENANT_ROLES) expect(isTenantRole(role)).toBe(true);
    expect(isTenantRole('superuser')).toBe(false);
    expect(isTenantRole(undefined)).toBe(false);
  });

  it('describes every permission key', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...PERMISSION_KEYS].sort());
    for (const key of PERMISSION_KEYS) expect(PERMISSIONS[key].length).toBeGreaterThan(0);
  });

  it.each(TENANT_ROLES)('grants %s exactly the reviewed permission set', (role) => {
    const expected = new Set(EXPECTED_MATRIX[role]);
    for (const key of PERMISSION_KEYS) {
      expect(hasPermission(role, key), `${role} → ${key}`).toBe(expected.has(key));
    }
  });

  it('keeps the viewer role read-only', () => {
    expect(hasPermission('viewer', 'webapp.write')).toBe(false);
    expect(hasPermission('viewer', 'tenant.member.read')).toBe(false);
    expect(hasPermission('viewer', 'tenant.member.manage')).toBe(false);
    expect(hasPermission('viewer', 'tenant.audit.read')).toBe(false);
  });

  it('lets members write business resources but not administer the tenant', () => {
    expect(hasPermission('member', 'webapp.write')).toBe(true);
    expect(hasPermission('member', 'tenant.member.manage')).toBe(false);
    expect(hasPermission('member', 'tenant.audit.read')).toBe(false);
    expect(hasPermission('member', 'tenant.settings.manage')).toBe(false);
  });

  it('keeps tenant settings owner-only, so an admin cannot rename or suspend a tenant', () => {
    expect(hasPermission('owner', 'tenant.settings.manage')).toBe(true);
    expect(hasPermission('admin', 'tenant.settings.manage')).toBe(false);
    expect(hasPermission('member', 'tenant.settings.manage')).toBe(false);
    expect(hasPermission('viewer', 'tenant.settings.manage')).toBe(false);
  });

  it('fails closed for an unrecognized role', () => {
    for (const key of PERMISSION_KEYS) {
      expect(hasPermission('superuser' as TenantRole, key)).toBe(false);
    }
  });
});

describe('tenant role rank and assignment guards', () => {
  it('orders owner above admin above member above viewer', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('member'));
    expect(roleRank('member')).toBeGreaterThan(roleRank('viewer'));
    expect(roleRank('superuser' as TenantRole)).toBe(-1);
  });

  it('lets an owner appoint any role, including another owner', () => {
    for (const target of TENANT_ROLES) expect(canAssignRole('owner', target)).toBe(true);
  });

  it('stops an admin from appointing or touching an owner or another admin', () => {
    expect(canAssignRole('admin', 'member')).toBe(true);
    expect(canAssignRole('admin', 'viewer')).toBe(true);
    expect(canAssignRole('admin', 'admin')).toBe(false);
    expect(canAssignRole('admin', 'owner')).toBe(false);
  });

  it('limits a member to strictly-lower roles and a viewer to none', () => {
    // The rank rule alone still lets a member bind the lowest role; what keeps
    // members out of the management API is the `tenant.member.manage` gate.
    expect(canAssignRole('member', 'viewer')).toBe(true);
    expect(canAssignRole('member', 'member')).toBe(false);
    expect(canAssignRole('member', 'admin')).toBe(false);
    expect(canAssignRole('member', 'owner')).toBe(false);
    expect(hasPermission('member', 'tenant.member.manage')).toBe(false);
    for (const target of TENANT_ROLES) expect(canAssignRole('viewer', target)).toBe(false);
  });

  it('rejects an unrecognized actor or target', () => {
    expect(canAssignRole('superuser' as TenantRole, 'member')).toBe(false);
    expect(canAssignRole('owner', 'superuser' as TenantRole)).toBe(false);
  });

  it('applies the same rank rule to changing or revoking an existing membership', () => {
    for (const actor of TENANT_ROLES) {
      for (const current of TENANT_ROLES) {
        expect(canModifyRole(actor, current), `${actor} → ${current}`).toBe(
          canAssignRole(actor, current),
        );
      }
    }
  });
});
