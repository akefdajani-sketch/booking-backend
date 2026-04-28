-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 053: Trial warning timestamp on tenant_subscriptions
--
-- PR F (Trial lifecycle hardening).
--
-- Adds one column:
--   tenant_subscriptions.trial_warning_sent_at TIMESTAMPTZ
--
-- Set when Stripe fires customer.subscription.trial_will_end (3 days before
-- trial_ends_at). The column doubles as a dedup guard so the platform doesn't
-- emit multiple warnings if Stripe re-fires the event for any reason, and
-- also as an audit trail so ak can see "yes, the heads-up was sent on
-- 2026-04-25T08:30Z".
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS trial_warning_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN tenant_subscriptions.trial_warning_sent_at IS
  'Timestamp when customer.subscription.trial_will_end fired for this subscription. NULL = not yet warned. Doubles as a dedup guard against duplicate Stripe webhook deliveries.';

-- Index supports the trial-sweep job's query "find recent trials that need
-- attention". Partial index on trialing-only rows keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_tenant_subs_trial_sweep
  ON tenant_subscriptions (trial_ends_at)
  WHERE status = 'trialing';

COMMIT;

-- Verification:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'tenant_subscriptions' AND column_name = 'trial_warning_sent_at';
-- Expected: 1 row.
