-- Resource tenant boundaries for the asset / material / render-job family.
--
-- A single user reaches these tables with the SAME owner key (`user:<userId>`)
-- in every tenant they belong to, so owner alone cannot separate one tenant's
-- uploads, asset blobs, or render jobs from another's. This migration adds the
-- durable boundary column the app/package write paths stamp and filter on.
--
-- `agent_owner_session_events` is included because its owner event stream is
-- keyed by owner alone; the projection carries the session's tenant so a
-- tenant-scoped reader never sees another tenant's entries.
--
-- The column is NULLABLE and intentionally has no NOT NULL / no default. `NULL`
-- is exactly what a legacy row carries — those owners have no tenant dimension,
-- and the unscoped legacy read paths still address them by owner alone. A
-- tenant-scoped reader adds `AND tenant_id = $n`, so a NULL row is invisible to
-- it (fail-closed) and another tenant's row is refused exactly like a missing
-- one.
--
-- Backfill mirrors 0019/0020: rows written by an OIDC-era deployment before the
-- column existed belong to that single deployment's controlled `default`
-- tenant. Anonymous rows (`anon:*`) are deliberately left NULL so legacy
-- behavior is unchanged.
--
-- Forward-only and replayable: ADD COLUMN IF NOT EXISTS, idempotent UPDATEs (a
-- second run matches no NULL user row), and CREATE INDEX IF NOT EXISTS leave a
-- re-run a no-op at every step.

ALTER TABLE asset_entries
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE owner_material
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE export_render_job_owners
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE agent_owner_session_events
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

UPDATE asset_entries
   SET tenant_id = 'default'
 WHERE tenant_id IS NULL
   AND principal LIKE 'user:%';

UPDATE owner_material
   SET tenant_id = 'default'
 WHERE tenant_id IS NULL
   AND owner_id LIKE 'user:%';

UPDATE export_render_job_owners
   SET tenant_id = 'default'
 WHERE tenant_id IS NULL
   AND owner_id LIKE 'user:%';

UPDATE agent_owner_session_events
   SET tenant_id = 'default'
 WHERE tenant_id IS NULL
   AND owner_id LIKE 'user:%';

CREATE INDEX IF NOT EXISTS asset_entries_tenant_principal_idx
  ON asset_entries (tenant_id, principal, id);

CREATE INDEX IF NOT EXISTS owner_material_tenant_owner_idx
  ON owner_material (tenant_id, owner_id, created_at);

CREATE INDEX IF NOT EXISTS export_render_job_owners_tenant_owner_idx
  ON export_render_job_owners (tenant_id, owner_id);

CREATE INDEX IF NOT EXISTS agent_owner_session_events_tenant_owner_id_idx
  ON agent_owner_session_events (tenant_id, owner_id, id);
