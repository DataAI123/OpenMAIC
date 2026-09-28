-- The active tenant of a signed application session, plus the administrative
-- audit trail for tenant and membership lifecycle actions.
--
-- Before this migration every session resolved to the seeded `default` tenant
-- through a literal in the session query, so a user who belongs to more than one
-- tenant had no way to say which one they were acting in. The active tenant
-- becomes explicit state on the session row: it is written at login when the
-- user's active membership is unambiguous, and changed only through an
-- authenticated switch that re-validates membership. Session resolution joins on
-- it and fails closed when it does not name an active membership.
--
-- Nullable on purpose. A session with no active tenant is a valid but refused
-- state (business routes answer `TENANT_REQUIRED`); backfilling a guess would
-- reintroduce the implicit selection this column exists to remove.
ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS active_tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

-- Existing live sessions predate the column. A session whose user has exactly
-- one active membership can only mean that tenant, so backfill it; a user with
-- several memberships stays NULL and must switch explicitly.
UPDATE auth_sessions AS s
   SET active_tenant_id = sole.tenant_id
  FROM (
    SELECT user_id, MIN(tenant_id) AS tenant_id
      FROM tenant_memberships
     WHERE status = 'active'
     GROUP BY user_id
    HAVING COUNT(*) = 1
  ) AS sole
 WHERE s.user_id = sole.user_id
   AND s.active_tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_active_tenant_idx
  ON auth_sessions (active_tenant_id)
  WHERE active_tenant_id IS NOT NULL;

-- Tenant and membership lifecycle audit, deliberately separate from
-- `tenant_role_audit` (0017). That table constrains each row to the
-- grant/change/revoke shape of a role binding; tenant creation, tenant state
-- changes and membership suspension have no role pair and would have to break
-- its CHECK. Both tables stay forward-only and are joined by `tenant_id`.
--
-- `subject_user_id` is nullable because a tenant-level action (create, rename,
-- suspend, activate) has no member as its subject, while a membership or
-- switch action does. `detail` carries the free-form reason or the tenant slug
-- the action produced, and is never used for authorization.
CREATE TABLE tenant_admin_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES app_users(id) ON DELETE RESTRICT,
  subject_user_id TEXT REFERENCES app_users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (
    action IN (
      'switch',
      'create',
      'rename',
      'suspend',
      'activate',
      'membership_suspend',
      'membership_resume',
      'leave'
    )
  ),
  detail TEXT,
  source TEXT NOT NULL CHECK (source IN ('api', 'cli')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX tenant_admin_audit_tenant_idx
  ON tenant_admin_audit (tenant_id, created_at DESC);

CREATE INDEX tenant_admin_audit_subject_idx
  ON tenant_admin_audit (subject_user_id, created_at DESC);