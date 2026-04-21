-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 040: Seed SaaS plans + feature matrix
--
-- Inserts the 4 public plans (Starter / Growth / Pro / Enterprise) plus one
-- hidden `legacy_grandfathered` plan for existing tenants.
--
-- Stripe price IDs are NULL — operator populates via:
--   UPDATE saas_plans SET stripe_price_id_yearly = 'price_xxx',
--                         stripe_price_id_monthly = 'price_yyy'
--   WHERE code = 'growth';
--
-- Feature matrix (✅ = enabled, ❌ = not in plan):
--
--   Feature                     Starter  Growth  Pro  Enterprise  Legacy
--   booking_codes                 ✅       ✅      ✅    ✅          ✅
--   memberships                   ❌       ✅      ✅    ✅          ✅
--   packages                      ❌       ✅      ✅    ✅          ✅
--   online_payments               ❌       ✅      ✅    ✅          ✅
--   tax_config                    ❌       ✅      ✅    ✅          ✅
--   email_reminders               ❌       ✅      ✅    ✅          ✅
--   calendar_planning             ❌       ❌      ✅    ✅          ✅
--   saved_preferences             ❌       ❌      ✅    ✅          ✅
--   sms_notifications             ❌       ❌      ✅    ✅          ✅
--   whatsapp_notifications        ❌       ❌      ✅    ✅          ✅
--   multi_location                ❌       ❌      ✅    ✅          ✅
--   advanced_reporting            ❌       ❌      ✅    ✅          ✅
--   priority_support              ❌       ❌      ✅    ✅          ✅
--   custom_branding               ❌       ❌      ❌    ✅          ✅
--   api_access                    ❌       ❌      ❌    ✅          ✅
--   white_label                   ❌       ❌      ❌    ✅          ✅
--   sso                           ❌       ❌      ❌    ✅          ✅
--
-- The 8 FEATURES constants in utils/entitlements.js all appear in this matrix.
-- Additional feature keys added here are declarative — wire them into
-- requireFeature() gates incrementally as features are productized.
--
-- All statements idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. UPSERT the 5 plans ──────────────────────────────────────────────────
INSERT INTO saas_plans (code, name, price_yearly, price_monthly, currency_code, tier_order, is_public, tagline, description, updated_at)
VALUES
  ('starter',              'Starter',              1200, 130,  'USD', 10, true,  'Essentials to take bookings online',        'Single-location booking for service businesses getting started. Unlimited bookings, basic scheduling, customer records.'),
  ('growth',               'Growth',               2988, 324,  'USD', 20, true,  'Memberships, payments, and prepaid packages','Everything in Starter, plus memberships, prepaid packages, online payments, and tax handling. For businesses ready to monetize recurring revenue.'),
  ('pro',                  'Pro',                  5988, 649,  'USD', 30, true,  'Multi-location + advanced ops tooling',     'Everything in Growth, plus multi-location, advanced reporting, SMS/WhatsApp notifications, calendar planning, saved preferences, priority support.'),
  ('enterprise',           'Enterprise',           NULL, NULL, 'USD', 40, true,  'Custom plans for teams at scale',           'Everything in Pro, plus custom branding, API access, white-label, SSO, and dedicated account management. Contact sales for pricing.'),
  ('legacy_grandfathered', 'Legacy (grandfathered)', NULL, NULL, 'USD',  0, false, 'Pre-pricing tenants — full feature access', 'Internal plan for tenants onboarded before the public pricing launch. All features enabled.')
ON CONFLICT (code) DO UPDATE SET
  name          = EXCLUDED.name,
  price_yearly  = EXCLUDED.price_yearly,
  price_monthly = EXCLUDED.price_monthly,
  currency_code = EXCLUDED.currency_code,
  tier_order    = EXCLUDED.tier_order,
  is_public     = EXCLUDED.is_public,
  tagline       = EXCLUDED.tagline,
  description   = EXCLUDED.description,
  updated_at    = NOW();
-- Note: stripe_price_id_* columns are intentionally NOT overwritten on UPSERT.
-- Operator populates them once after Stripe Dashboard setup; re-running this
-- migration must not clear them. This is also why they're absent from the
-- INSERT column list above.

-- ── 2. Wipe and reseed the feature matrix ──────────────────────────────────
-- Features are idempotent by design: delete then insert keeps the matrix
-- fully declarative in this file. Safe because feature flags are looked up
-- per-request and cached briefly; a ~50ms gap in the middle of a migration
-- won't cause production impact.
DELETE FROM saas_plan_features
WHERE plan_id IN (SELECT id FROM saas_plans WHERE code IN ('starter','growth','pro','enterprise','legacy_grandfathered'));

-- Helper: resolve plan IDs
WITH plans AS (
  SELECT id, code FROM saas_plans WHERE code IN ('starter','growth','pro','enterprise','legacy_grandfathered')
)
INSERT INTO saas_plan_features (plan_id, feature_key, enabled, display_label)
SELECT p.id, f.feature_key, true, f.display_label
FROM plans p
JOIN (
  VALUES
    -- feature_key                 plans_enabled                                        display_label
    ('booking_codes',              ARRAY['starter','growth','pro','enterprise','legacy_grandfathered']::text[],                          'Booking reference codes'),
    ('memberships',                ARRAY['growth','pro','enterprise','legacy_grandfathered']::text[],                                    'Memberships'),
    ('packages',                   ARRAY['growth','pro','enterprise','legacy_grandfathered']::text[],                                    'Prepaid packages'),
    ('online_payments',            ARRAY['growth','pro','enterprise','legacy_grandfathered']::text[],                                    'Online payments (Stripe, MPGS)'),
    ('tax_config',                 ARRAY['growth','pro','enterprise','legacy_grandfathered']::text[],                                    'Tax & service charge'),
    ('email_reminders',            ARRAY['growth','pro','enterprise','legacy_grandfathered']::text[],                                    'Email booking reminders'),
    ('calendar_planning',          ARRAY['pro','enterprise','legacy_grandfathered']::text[],                                             'Calendar planning mode'),
    ('saved_preferences',          ARRAY['pro','enterprise','legacy_grandfathered']::text[],                                             'Saved customer preferences'),
    ('sms_notifications',          ARRAY['pro','enterprise','legacy_grandfathered']::text[],                                             'SMS notifications (Twilio)'),
    ('whatsapp_notifications',     ARRAY['pro','enterprise','legacy_grandfathered']::text[],                                             'WhatsApp notifications'),
    ('multi_location',             ARRAY['pro','enterprise','legacy_grandfathered']::text[],                                             'Multi-location'),
    ('advanced_reporting',         ARRAY['pro','enterprise','legacy_grandfathered']::text[],                                             'Advanced reporting & exports'),
    ('priority_support',           ARRAY['pro','enterprise','legacy_grandfathered']::text[],                                             'Priority support'),
    ('custom_branding',            ARRAY['enterprise','legacy_grandfathered']::text[],                                                   'Custom branding & themes'),
    ('api_access',                 ARRAY['enterprise','legacy_grandfathered']::text[],                                                   'API access & webhooks'),
    ('white_label',                ARRAY['enterprise','legacy_grandfathered']::text[],                                                   'White-label'),
    ('sso',                        ARRAY['enterprise','legacy_grandfathered']::text[],                                                   'SSO / SAML')
) AS f(feature_key, plans_enabled, display_label)
  ON p.code = ANY(f.plans_enabled);

-- ── 3. Sanity check — every public plan must have booking_codes ─────────────
-- (booking_codes is on every plan; if it's missing from any, the seed failed.)
DO $$
DECLARE
  missing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_count
  FROM saas_plans sp
  WHERE sp.code IN ('starter','growth','pro','enterprise','legacy_grandfathered')
    AND NOT EXISTS (
      SELECT 1 FROM saas_plan_features spf
      WHERE spf.plan_id = sp.id AND spf.feature_key = 'booking_codes'
    );

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Seed integrity check failed: % plan(s) missing booking_codes feature', missing_count;
  END IF;
END $$;

COMMIT;
