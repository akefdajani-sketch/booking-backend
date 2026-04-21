-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 039: Extend saas_plans for Stripe + public display
--
-- Adds columns to support:
--   1. Stripe price IDs (yearly + monthly SKUs — NULL-filled at migration time,
--      populated after operator creates the Products/Prices in Stripe Dashboard
--      and inserts the `price_xxx` IDs via SQL or an admin endpoint).
--   2. Public display (price, currency, tier order, is_public flag, tagline).
--
-- Locked pricing model (decision #3 + #6):
--   - Starter    $1200/yr  → $100/mo annual rate  | $130/mo monthly (+30%)
--   - Growth     $2988/yr  → $249/mo annual rate  | $324/mo monthly (+30%)
--   - Pro        $5988/yr  → $499/mo annual rate  | $649/mo monthly (+30%)
--   - Enterprise Custom    → contact sales (no Stripe SKU, no public price)
--
-- Migration 040 seeds the plans + features.
-- Migration 041 grandfathers existing tenants.
--
-- All statements idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE saas_plans
  ADD COLUMN IF NOT EXISTS stripe_price_id_yearly   TEXT,
  ADD COLUMN IF NOT EXISTS stripe_price_id_monthly  TEXT,
  ADD COLUMN IF NOT EXISTS price_yearly             NUMERIC,
  ADD COLUMN IF NOT EXISTS price_monthly            NUMERIC,
  ADD COLUMN IF NOT EXISTS currency_code            TEXT DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS tier_order               INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_public                BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tagline                  TEXT,
  ADD COLUMN IF NOT EXISTS description              TEXT,
  ADD COLUMN IF NOT EXISTS updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN saas_plans.stripe_price_id_yearly IS
  'Stripe Price ID (price_xxx) for the yearly SKU. NULL until operator populates after creating in Stripe Dashboard.';

COMMENT ON COLUMN saas_plans.stripe_price_id_monthly IS
  'Stripe Price ID for the monthly SKU. NULL until populated.';

COMMENT ON COLUMN saas_plans.price_yearly IS
  'Annual price (for display on pricing page). Source of truth is Stripe; this is cached for UI rendering.';

COMMENT ON COLUMN saas_plans.price_monthly IS
  'Monthly price (for display on pricing page). Should be ~1.30 × (price_yearly / 12) per 30% monthly-premium policy.';

COMMENT ON COLUMN saas_plans.is_public IS
  'If false, plan is hidden from the public pricing page. Used for legacy grandfathered plans and internal/custom plans.';

COMMENT ON COLUMN saas_plans.tier_order IS
  'Sort order on pricing page. Lowest first. Starter=10, Growth=20, Pro=30, Enterprise=40. Legacy=0 (hidden).';

-- Ensure stripe_price_ids are unique when populated (prevents pointing two plans
-- at the same Stripe SKU by accident).
CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_plans_stripe_yearly
  ON saas_plans (stripe_price_id_yearly)
  WHERE stripe_price_id_yearly IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_plans_stripe_monthly
  ON saas_plans (stripe_price_id_monthly)
  WHERE stripe_price_id_monthly IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_saas_plans_public_tier
  ON saas_plans (is_public, tier_order)
  WHERE is_public = true;

-- ── Extend saas_plan_features: add display metadata for pricing page ────────
ALTER TABLE saas_plan_features
  ADD COLUMN IF NOT EXISTS display_label TEXT;

COMMENT ON COLUMN saas_plan_features.display_label IS
  'Human-readable label shown on pricing page feature list. If NULL, feature_key is humanized client-side.';

COMMIT;
