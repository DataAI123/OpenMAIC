-- Per-user, per-UTC-month quotas for the atomic paid media modalities:
-- image (张 / unit 'image'), video (秒 / unit 'second') and TTS (字符 / unit
-- 'character'). Kept separate from the token-stream LLM quota (0002): a media
-- operation carries a single quantity known up front, so it uses a
-- modality-keyed counter with the same reserve/settle/release lease model. The
-- amount columns carry each modality's own unit and are never a money value.
CREATE TABLE personal_media_quota_policies (
  modality TEXT PRIMARY KEY CHECK (modality IN ('image', 'video', 'tts')),
  unit TEXT NOT NULL CHECK (unit IN ('image', 'second', 'character')),
  period_kind TEXT NOT NULL CHECK (period_kind = 'utc_calendar_month'),
  limit_amount BIGINT NOT NULL CHECK (limit_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Confirmed "balanced pilot" allowance for the controlled single-tenant phase.
INSERT INTO personal_media_quota_policies (modality, unit, period_kind, limit_amount) VALUES
  ('image', 'image',     'utc_calendar_month', 2000),
  ('video', 'second',    'utc_calendar_month', 3600),
  ('tts',   'character', 'utc_calendar_month', 2000000);

CREATE TABLE personal_media_quota_months (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  modality TEXT NOT NULL REFERENCES personal_media_quota_policies(modality) ON DELETE RESTRICT,
  limit_amount BIGINT NOT NULL CHECK (limit_amount >= 0),
  used_amount BIGINT NOT NULL DEFAULT 0 CHECK (used_amount >= 0),
  reserved_amount BIGINT NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, period_start, modality)
);

CREATE TABLE personal_media_quota_reservations (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  period_start DATE NOT NULL,
  modality TEXT NOT NULL,
  reserved_amount BIGINT NOT NULL CHECK (reserved_amount > 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  actual_amount BIGINT CHECK (actual_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (user_id, period_start, modality)
    REFERENCES personal_media_quota_months(user_id, period_start, modality) ON DELETE RESTRICT,
  CHECK ((status = 'settled') = (actual_amount IS NOT NULL)),
  CHECK ((status = 'reserved') = (completed_at IS NULL))
);

CREATE INDEX personal_media_quota_reservations_open_idx
  ON personal_media_quota_reservations (user_id, period_start, modality, created_at)
  WHERE status = 'reserved';
