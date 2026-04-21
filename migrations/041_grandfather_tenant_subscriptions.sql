-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 041: Grandfather existing tenants + assign demos to Pro
--
-- Problem: utils/entitlements.js gates features based on the tenant's active
-- subscription. Tenants with no active subscription are implicitly "Starter"
-- (empty feature set). If we roll out plan enforcement without first
-- assigning existing tenants to a plan, every production tenant suddenly
-- loses memberships, payments, and everything else.
--
-- Solution: this migration seeds tenant_subscriptions rows for:
--   1. Every non-demo tenant with no existing active/trialing subscription
--      → assigned to `legacy_grandfathered` (all features enabled, invisible
--      from the public pricing page).
--   2. Every demo tenant (is_demo=true) with no existing active/trialing sub
--      → assigned to Pro (so prospects see the full product experience on
--      a demo click-through).
--
-- Both use WHERE NOT EXISTS guards so running this migration never overwrites
-- a subscription that was set up through Stripe or admin tooling.
--
-- Depends on: 038 (is_demo), 040 (plans + features seeded).
-- All statements idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Grandfather non-demo tenants ─────────────────────────────────────────
INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, started_at)
SELECT
  t.id,
  (SELECT id FROM saas_plans WHERE code = 'legacy_grandfathered'),
  'active',
  NOW()
FROM tenants t
WHERE COALESCE(t.is_demo, false) = false
  AND NOT EXISTS (
    SELECT 1 FROM tenant_subscriptions ts
    WHERE ts.tenant_id = t.id
      AND ts.status IN ('active', 'trialing')
  );

-- ── 2. Assign demo tenants to Pro ───────────────────────────────────────────
INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, started_at)
SELECT
  t.id,
  (SELECT id FROM saas_plans WHERE code = 'pro'),
  'active',
  NOW()
FROM tenants t
WHERE COALESCE(t.is_demo, false) = true
  AND NOT EXISTS (
    SELECT 1 FROM tenant_subscriptions ts
    WHERE ts.tenant_id = t.id
      AND ts.status IN ('active', 'trialing')
  );

-- ── 3. Sanity check — every tenant has exactly one active or trialing sub ──
DO $$
DECLARE
  unsubbed_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO unsubbed_count
  FROM tenants t
  WHERE NOT EXISTS (
    SELECT 1 FROM tenant_subscriptions ts
    WHERE ts.tenant_id = t.id
      AND ts.status IN ('active', 'trialing')
  );

  IF unsubbed_count > 0 THEN
    RAISE WARNING 'Grandfather check: % tenant(s) still have no active subscription after seed', unsubbed_count;
  END IF;
END $$;

COMMIT;
