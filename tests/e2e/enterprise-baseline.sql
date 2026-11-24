-- Minimal legacy application tables required by migrations/0001..0023 in the
-- disposable PostgreSQL service used by the enterprise OIDC browser tests.
CREATE TABLE stage_meta (stage_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
CREATE TABLE document_folders (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
CREATE TABLE document_stages (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE TABLE agent_owner_session_events (
  owner_id TEXT NOT NULL,
  id BIGINT NOT NULL,
  ts BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT,
  attempt INTEGER,
  data JSONB NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE TABLE asset_entries (id TEXT PRIMARY KEY, principal TEXT NOT NULL);
CREATE TABLE owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-user', 'user:legacy');
INSERT INTO document_folders (id, owner_id) VALUES ('folder-user', 'user:legacy');
INSERT INTO document_stages (id, owner_id) VALUES ('document-user', 'user:legacy');
INSERT INTO agent_sessions (id, owner_id) VALUES
  ('session-user', 'user:legacy'), ('session-anon', 'anon:legacy');
INSERT INTO agent_owner_session_events
  (owner_id, id, ts, session_id, type, data) VALUES
  ('user:legacy', 1, 1, 'session-user', 'session_created', '{}'),
  ('anon:legacy', 2, 2, 'session-anon', 'session_created', '{}');
INSERT INTO asset_entries (id, principal) VALUES
  ('asset-user', 'user:legacy'), ('asset-anon', 'anon:legacy');
INSERT INTO owner_material (id, owner_id) VALUES
  ('material-user', 'user:legacy'), ('material-anon', 'anon:legacy');
