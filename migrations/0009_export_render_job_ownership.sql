-- Durable owner binding for MP4 render-service jobs.
--
-- The export-video pipeline proxies an EXTERNAL render service that keys nothing
-- by user: a client that learns a job id could poll its status, cancel it, or —
-- worst — download another user's rendered MP4. `x-openmaic-client` forwarded at
-- submit is only a per-IP rate-limit bucket (spoofable, collapses to `direct`),
-- never an authorization identity, so ownership has to be recorded app-side.
--
-- The app inserts (job_id -> owner_id) when it relays a successful submit, then
-- re-checks it on poll/cancel/download. An unbound or foreign job is answered
-- with the same plain 404 (no existence oracle). This is an authorization
-- binding, deliberately separate from the metering tables (0002/0006).
--
-- `owner_id` stores the raw request owner (e.g. `user:<id>` under OIDC, or a
-- legacy `anon:<id>` cookie owner) and is intentionally NOT an FK to app_users:
-- legacy anonymous owners have no user row, and an orphan binding after a user
-- delete is harmless — it simply stops matching. Rows are swept in the engine
-- after the retention window; there is no scheduled job here.
CREATE TABLE export_render_job_owners (
  job_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX export_render_job_owners_owner_idx
  ON export_render_job_owners (owner_id);

CREATE INDEX export_render_job_owners_created_idx
  ON export_render_job_owners (created_at);
