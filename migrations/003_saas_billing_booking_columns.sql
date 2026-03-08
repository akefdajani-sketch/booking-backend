-- migrations/003_saas_billing_booking_columns.sql
-- PR-5: Migration System + DB Integrity
--
-- SaaS plan tables (saas_plans, saas_plan_features, tenant_subscriptions)
-- and additive columns on bookings (money, rate snapshot, working hours).
-- All idempotent.

-- ─── SaaS plans ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_plans (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saas_plan_features (
  id           SERIAL PRIMARY KEY,
  plan_id      INTEGER NOT NULL REFERENCES saas_plans(id) ON DELETE CASCADE,
  feature_key  TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  limit_value  INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (plan_id, feature_key)
);

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id       INTEGER NOT NULL REFERENCES saas_plans(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'trialing',
  trial_ends_at TIMESTAMPTZ,
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  cancelled_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_tenant
  ON tenant_subscriptions (tenant_id);

-- Additive column guards — safe on existing production databases
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'trialing';
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS started_at   TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- ─── Booking money columns ────────────────────────────────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_amount          NUMERIC;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS charge_amount         NUMERIC;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS currency_code         TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS applied_rate_rule_id  INT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS applied_rate_snapshot JSONB;

-- ─── Tenant working hours ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_working_hours (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time   TIME NOT NULL,
  close_time  TIME NOT NULL,
  is_closed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_tenant_working_hours_tenant
  ON tenant_working_hours (tenant_id);
