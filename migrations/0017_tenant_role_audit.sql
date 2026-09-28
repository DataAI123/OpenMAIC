-- Administrative audit trail for tenant role bindings. Every authorized role
-- grant, change or revoke writes one row — including the CLI provisioning path,
-- where the acting user is unknown and actor_user_id stays NULL. The shape
-- constraint keeps each action's role columns self-consistent, so a "grant" can
-- never carry a previous role and a "revoke" can never carry a new one.
CREATE TABLE tenant_role_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES app_users(id) ON DELETE RESTRICT,
  subject_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('grant', 'change', 'revoke')),
  previous_role TEXT
    CHECK (previous_role IS NULL OR previous_role IN ('owner', 'admin', 'member', 'viewer')),
  new_role TEXT
    CHECK (new_role IS NULL OR new_role IN ('owner', 'admin', 'member', 'viewer')),
  source TEXT NOT NULL CHECK (source IN ('api', 'cli')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tenant_role_audit_shape CHECK (
    (action = 'grant' AND previous_role IS NULL AND new_role IS NOT NULL)
    OR (action = 'change' AND previous_role IS NOT NULL AND new_role IS NOT NULL)
    OR (action = 'revoke' AND previous_role IS NOT NULL AND new_role IS NULL)
  )
);

CREATE INDEX tenant_role_audit_tenant_idx
  ON tenant_role_audit (tenant_id, created_at DESC);

CREATE INDEX tenant_role_audit_subject_idx
  ON tenant_role_audit (subject_user_id, created_at DESC);
