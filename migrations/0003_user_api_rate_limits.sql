-- Fixed-window counters for authenticated user API operations. A single row per
-- user and route key keeps storage bounded and allows atomic multi-instance admission.
CREATE TABLE user_api_rate_limits (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  route_key TEXT NOT NULL CHECK (route_key IN ('provider_probe_models', 'verify_model')),
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (user_id, route_key)
);
