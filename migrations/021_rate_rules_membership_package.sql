-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 021: Rate rules — membership and package scope
--
-- Adds two optional FK columns so a rate rule can be restricted to customers
-- who hold a specific membership plan or prepaid package entitlement.
--
-- NULL = rule applies to all customers regardless of membership/package status.
-- Non-null = rule only fires when the booking customer holds that plan/product.
--
-- ON DELETE SET NULL: deleting a plan/product silently un-scopes the rule
-- rather than hard-deleting it (keeps historical pricing data intact).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE rate_rules
  ADD COLUMN IF NOT EXISTS membership_plan_id  BIGINT REFERENCES membership_plans(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS prepaid_product_id  BIGINT REFERENCES prepaid_products(id)  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rate_rules_membership_plan ON rate_rules (membership_plan_id) WHERE membership_plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rate_rules_prepaid_product ON rate_rules (prepaid_product_id)  WHERE prepaid_product_id  IS NOT NULL;

COMMENT ON COLUMN rate_rules.membership_plan_id IS 'If set, rule only applies to customers who hold an active membership on this plan.';
COMMENT ON COLUMN rate_rules.prepaid_product_id IS 'If set, rule only applies to customers who hold an active entitlement for this prepaid package.';
