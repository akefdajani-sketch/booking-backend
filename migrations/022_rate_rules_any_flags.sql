-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 022: Rate rules — "any membership" and "any package" scope flags
--
-- Adds two boolean flags so a rate rule can fire for ANY customer holding
-- ANY active membership or prepaid package, without specifying a specific plan.
--
-- Logic matrix (per column pair):
--   require_any_membership = false, membership_plan_id = NULL  → no membership restriction
--   require_any_membership = true,  membership_plan_id = NULL  → any active membership
--   require_any_membership = false, membership_plan_id = N     → specific plan N only
--
-- Same logic applies to require_any_prepaid + prepaid_product_id.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE rate_rules
  ADD COLUMN IF NOT EXISTS require_any_membership BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_any_prepaid    BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN rate_rules.require_any_membership IS 'If true, rule fires for any customer holding any active membership plan (ignores membership_plan_id).';
COMMENT ON COLUMN rate_rules.require_any_prepaid    IS 'If true, rule fires for any customer holding any active prepaid package entitlement (ignores prepaid_product_id).';
