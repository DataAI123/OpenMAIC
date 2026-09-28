-- Resource tenant boundaries for the agent-session family.
--
-- A single user reaches `agent_sessions` with the SAME `owner_id`
-- (`user:<userId>`) in every tenant they belong to, so owner alone cannot
-- separate one tenant's conversations from another's. This migration adds the
-- durable boundary column the app-side store stamps and filters on; the
-- `agent_session_events` / `agent_session_entries` / `agent_session_urls`
-- tables inherit the boundary through their `session_id` foreign key and need
-- no column of their own.
--
-- The column is NULLABLE and intentionally has no NOT NULL / no default.
-- `NULL` is exactly what a legacy (anonymous) session carries — those owners
-- have no tenant dimension, and the unscoped legacy store still addresses them
-- by owner alone. A tenant-scoped store stamps its tenant on create and adds
-- `AND tenant_id = $n` to every read, so a NULL row is invisible to it
-- (fail-closed) and another tenant's row is refused exactly like a missing one.
--
-- Backfill is best-effort and mirrors 0019: sessions written by an OIDC-era
-- deployment before the column existed belong to that single deployment's
-- controlled `default` tenant — the same sentinel 0001 used for `stage_meta`.
-- Anonymous rows are deliberately left NULL so legacy behavior is unchanged.
--
-- Forward-only and replayable: ADD COLUMN IF NOT EXISTS, an idempotent UPDATE
-- (a second run matches no NULL user row), and CREATE INDEX IF NOT EXISTS leave
-- a re-run a no-op at every step.

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

UPDATE agent_sessions
   SET tenant_id = 'default'
 WHERE tenant_id IS NULL
   AND owner_id LIKE 'user:%';

CREATE INDEX IF NOT EXISTS agent_sessions_tenant_owner_live_idx
  ON agent_sessions (tenant_id, owner_id, created_at) WHERE deleted_at IS NULL;
