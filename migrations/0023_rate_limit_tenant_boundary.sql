-- Rate-limit / burst-allowance tenant boundary.
--
-- The fixed-window counters (0003) were keyed by `(user_id, route_key)` alone. In
-- a multi-tenant OIDC deployment one user reaches this counter with the SAME
-- `user_id` in every tenant they belong to, so all their tenants shared one
-- window: a burst in tenant A answered `429` to tenant B, and vice versa. This
-- migration makes the tenant part of the key so each `(tenant, user, route)`
-- carries its own window.
--
-- Unlike the resource-boundary migrations (0019-0021) the column is NOT NULL
-- with a `default` sentinel rather than nullable, matching 0022. This table only
-- ever holds authenticated `user:` rows -- `user_id` has a foreign key to
-- `app_users` and the engine refuses every other owner shape -- so there is no
-- anonymous row that would need a NULL tenant. A nullable column would also let
-- two NULL rows for the same `(user, route)` coexist, because Postgres treats
-- NULLs as distinct inside a unique constraint.
--
-- Every pre-existing row was written by a single-tenant era, so it belongs to
-- that deployment's controlled `default` tenant -- the same sentinel 0001 used.
--
-- Forward-only and replayable: `ADD COLUMN IF NOT EXISTS` and a primary-key swap
-- guarded by the current definition leave a re-run a no-op at every step.

ALTER TABLE user_api_rate_limits
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Re-key the fixed window on the tenant. The swap is skipped when the current
-- primary key already carries `tenant_id`, so a replay is a true no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'user_api_rate_limits'::regclass
       AND conname = 'user_api_rate_limits_pkey'
       AND pg_get_constraintdef(oid) NOT LIKE '%tenant_id%'
  ) THEN
    ALTER TABLE user_api_rate_limits DROP CONSTRAINT user_api_rate_limits_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'user_api_rate_limits'::regclass
       AND conname = 'user_api_rate_limits_pkey'
  ) THEN
    ALTER TABLE user_api_rate_limits
      ADD CONSTRAINT user_api_rate_limits_pkey
      PRIMARY KEY (tenant_id, user_id, route_key);
  END IF;
END $$;
