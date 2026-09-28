CREATE TABLE app_users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email_snapshot TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT external_identities_issuer_subject_unique UNIQUE (issuer, subject)
);

CREATE INDEX external_identities_user_idx ON external_identities (user_id);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tenant_memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX tenant_memberships_user_idx
  ON tenant_memberships (user_id, status, tenant_id);

CREATE TABLE auth_sessions (
  sid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL,
  idp_sid TEXT,
  auth_time TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX auth_sessions_user_live_idx
  ON auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

INSERT INTO tenants (id, slug, name)
VALUES ('default', 'default', 'Default organization');

ALTER TABLE stage_meta
  ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

-- Existing single-deployment resources enter the controlled default tenant.
-- This does not claim unknown anonymous courses for a user; it only supplies
-- the tenant boundary that the pre-existing deployment did not record.
UPDATE stage_meta SET tenant_id = 'default' WHERE tenant_id IS NULL;

ALTER TABLE stage_meta
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT 'default';

CREATE INDEX stage_meta_tenant_owner_idx
  ON stage_meta (tenant_id, owner_id, stage_id);
