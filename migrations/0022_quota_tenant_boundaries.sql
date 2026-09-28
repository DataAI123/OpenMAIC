-- Quota / spend-cap tenant boundaries for the personal usage quota family.
--
-- The monthly LLM token quota (0002) and the per-modality media quota (0006)
-- were keyed by `user_id` (+ period, + modality) alone. In a multi-tenant OIDC
-- deployment one user reaches these counters with the SAME `user_id` in every
-- tenant they belong to, so the tenants shared one budget: exhausting the cap in
-- tenant A silently denied tenant B. This migration makes the tenant part of the
-- quota key so each `(tenant, user, period)` carries its own counters.
--
-- Unlike the resource-boundary migrations (0019-0021) the column is NOT NULL
-- with a `default` sentinel rather than nullable. These tables only ever hold
-- authenticated `user:` rows -- the engines refuse every other owner shape and
-- `user_id` has a foreign key to `app_users` -- so there is no anonymous row
-- that would need a NULL tenant. A NOT NULL column also keeps the primary key
-- and foreign key usable: Postgres treats NULLs as distinct inside a unique
-- constraint, which would let two NULL rows for the same `(user, period)`
-- coexist and silently split a budget.
--
-- Every pre-existing row was written by a single-tenant era, so it belongs to
-- that deployment's controlled `default` tenant -- the same sentinel 0001 used.
--
-- Forward-only and replayable: `ADD COLUMN IF NOT EXISTS`, constraint swaps
-- guarded by the current definition, and DROP/CREATE INDEX leave a re-run a
-- no-op at every step.

ALTER TABLE personal_usage_quota_months
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE personal_usage_quota_reservations
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE personal_media_quota_months
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE personal_media_quota_reservations
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Drop the `(user_id, period[, modality])` parent foreign keys before the parent
-- primary keys are re-keyed; they are recreated below against the new key. The
-- `NOT LIKE '%tenant_id%'` guard makes a replay a true no-op (the recreated key
-- already carries the tenant).
DO $$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'personal_usage_quota_reservations'::regclass
       AND contype = 'f'
       AND confrelid = 'personal_usage_quota_months'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%tenant_id%'
  LOOP
    EXECUTE format('ALTER TABLE personal_usage_quota_reservations DROP CONSTRAINT %I', fk.conname);
  END LOOP;

  FOR fk IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'personal_media_quota_reservations'::regclass
       AND contype = 'f'
       AND confrelid = 'personal_media_quota_months'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%tenant_id%'
  LOOP
    EXECUTE format(
      'ALTER TABLE personal_media_quota_reservations DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;

-- Re-key the month counters on the tenant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'personal_usage_quota_months'::regclass
       AND conname = 'personal_usage_quota_months_pkey'
       AND pg_get_constraintdef(oid) NOT LIKE '%tenant_id%'
  ) THEN
    ALTER TABLE personal_usage_quota_months DROP CONSTRAINT personal_usage_quota_months_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'personal_usage_quota_months'::regclass
       AND conname = 'personal_usage_quota_months_pkey'
  ) THEN
    ALTER TABLE personal_usage_quota_months
      ADD CONSTRAINT personal_usage_quota_months_pkey
      PRIMARY KEY (tenant_id, user_id, period_start);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'personal_media_quota_months'::regclass
       AND conname = 'personal_media_quota_months_pkey'
       AND pg_get_constraintdef(oid) NOT LIKE '%tenant_id%'
  ) THEN
    ALTER TABLE personal_media_quota_months DROP CONSTRAINT personal_media_quota_months_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'personal_media_quota_months'::regclass
       AND conname = 'personal_media_quota_months_pkey'
  ) THEN
    ALTER TABLE personal_media_quota_months
      ADD CONSTRAINT personal_media_quota_months_pkey
      PRIMARY KEY (tenant_id, user_id, period_start, modality);
  END IF;
END $$;

-- Recreate the parent foreign keys against the tenant-inclusive key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'personal_usage_quota_reservations'::regclass
       AND contype = 'f'
       AND confrelid = 'personal_usage_quota_months'::regclass
  ) THEN
    ALTER TABLE personal_usage_quota_reservations
      ADD CONSTRAINT personal_usage_quota_reservations_month_fkey
      FOREIGN KEY (tenant_id, user_id, period_start)
      REFERENCES personal_usage_quota_months (tenant_id, user_id, period_start)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'personal_media_quota_reservations'::regclass
       AND contype = 'f'
       AND confrelid = 'personal_media_quota_months'::regclass
  ) THEN
    ALTER TABLE personal_media_quota_reservations
      ADD CONSTRAINT personal_media_quota_reservations_month_fkey
      FOREIGN KEY (tenant_id, user_id, period_start, modality)
      REFERENCES personal_media_quota_months (tenant_id, user_id, period_start, modality)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- The open-reservation index backs the expired-lease reclaim and the reservation
-- lookup, so it has to lead with the tenant as well.
DROP INDEX IF EXISTS personal_usage_quota_reservations_open_idx;
CREATE INDEX IF NOT EXISTS personal_usage_quota_reservations_open_idx
  ON personal_usage_quota_reservations (tenant_id, user_id, period_start, created_at)
  WHERE status = 'reserved';

DROP INDEX IF EXISTS personal_media_quota_reservations_open_idx;
CREATE INDEX IF NOT EXISTS personal_media_quota_reservations_open_idx
  ON personal_media_quota_reservations (tenant_id, user_id, period_start, modality, created_at)
  WHERE status = 'reserved';
