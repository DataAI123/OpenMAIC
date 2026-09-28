-- Resource tenant boundaries for the course / folder family.
--
-- Migration 0001 already gave `stage_meta` a `tenant_id` (NOT NULL DEFAULT
-- 'default'); that table is where the course family's tenant gate is enforced,
-- because it is the one row every document mutation locks before writing. This
-- migration gives the two package-owned tables the same durable boundary
-- column and a composite index, so a resource row can always be attributed to
-- the tenant it was created in without a join, and so the package's write path
-- can populate it directly as later boundaries land.
--
-- Backfill mirrors 0001: rows written before the column existed belong to the
-- single deployment's controlled `default` tenant. This does not claim a row
-- for a user; it only supplies the boundary the pre-existing schema did not
-- record. Nullable-then-NOT-NULL, so the column is usable in indexes and no
-- reader has to interpret a NULL as "unknown tenant".
--
-- Forward-only and replayable: ADD COLUMN IF NOT EXISTS, an idempotent UPDATE,
-- and CREATE INDEX IF NOT EXISTS leave a re-run a no-op at every step.

ALTER TABLE document_folders
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

UPDATE document_folders SET tenant_id = 'default' WHERE tenant_id IS NULL;
UPDATE document_stages SET tenant_id = 'default' WHERE tenant_id IS NULL;

ALTER TABLE document_folders
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT 'default';

ALTER TABLE document_stages
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN tenant_id SET DEFAULT 'default';

CREATE INDEX IF NOT EXISTS document_folders_tenant_owner_idx
  ON document_folders (tenant_id, owner_id, id);

CREATE INDEX IF NOT EXISTS document_stages_tenant_owner_idx
  ON document_stages (tenant_id, owner_id, id)
  WHERE owner_id IS NOT NULL;
