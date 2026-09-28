-- Monthly personal LLM token quotas use PostgreSQL counters so reservation
-- and settlement can be atomic across concurrent app instances.
CREATE TABLE personal_usage_quota_policies (
  modality TEXT PRIMARY KEY CHECK (modality = 'llm'),
  unit TEXT NOT NULL CHECK (unit = 'token'),
  period_kind TEXT NOT NULL CHECK (period_kind = 'utc_calendar_month'),
  limit_amount BIGINT NOT NULL CHECK (limit_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO personal_usage_quota_policies (modality, unit, period_kind, limit_amount)
VALUES ('llm', 'token', 'utc_calendar_month', 1000000000);

CREATE TABLE personal_usage_quota_months (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  limit_tokens BIGINT NOT NULL CHECK (limit_tokens >= 0),
  used_tokens BIGINT NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, period_start)
);

CREATE TABLE personal_usage_quota_reservations (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  period_start DATE NOT NULL,
  reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens > 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  actual_tokens BIGINT CHECK (actual_tokens >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (user_id, period_start)
    REFERENCES personal_usage_quota_months(user_id, period_start) ON DELETE RESTRICT,
  CHECK ((status = 'settled') = (actual_tokens IS NOT NULL)),
  CHECK ((status = 'reserved') = (completed_at IS NULL))
);

CREATE INDEX personal_usage_quota_reservations_open_idx
  ON personal_usage_quota_reservations (user_id, period_start, created_at)
  WHERE status = 'reserved';
