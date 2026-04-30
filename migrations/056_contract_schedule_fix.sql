-- migrations/056_contract_schedule_fix.sql
-- FINAL-CONTRACT-FIX
--
-- Schema additions to support the unified contract-schedule generator:
--
--   1. payment_schedule_templates.duration_months — fixed-duration templates
--      (3-Month, 6-Month, 12-Month) drive end_date and the schedule shape.
--      NULL for variable-duration templates (Long Stay 15-60 nights, which
--      uses signing/check_in/mid_stay triggers).
--
--   2. contract_invoices.is_deposit — flags the security-deposit invoice so
--      the future credit-note / refund workflow can distinguish it from rent
--      invoices. Today's release only sets the flag; refund flow ships in a
--      follow-on PR.
--
-- IDEMPOTENT: every ALTER uses IF NOT EXISTS, every UPDATE is a no-op on
-- re-run. Safe to run multiple times.
--
-- DATA REPAIR for the two existing bad contracts (Aqaba 0005 and 0006) is
-- done by `scripts/repair-contract-schedules.js`, NOT by this migration. The
-- script runs on demand and uses the new generator end-to-end so the repair
-- matches what new contracts produce.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. payment_schedule_templates.duration_months
-- ---------------------------------------------------------------------------

ALTER TABLE payment_schedule_templates
  ADD COLUMN IF NOT EXISTS duration_months INTEGER;

COMMENT ON COLUMN payment_schedule_templates.duration_months IS
  'Fixed contract duration in months. NOT NULL → template drives end_date and uses '
  'the unified rent-prorated generator. NULL → variable-duration template '
  '(e.g. Long Stay 15-60 nights), uses milestone percentages from the milestones JSON.';

-- Backfill platform-seeded templates. Identified by tenant_id IS NULL + name pattern.
UPDATE payment_schedule_templates
   SET duration_months = 3
 WHERE tenant_id IS NULL
   AND name = 'Platform: 3-Month Contract'
   AND duration_months IS NULL;

UPDATE payment_schedule_templates
   SET duration_months = 6
 WHERE tenant_id IS NULL
   AND name = 'Platform: 6-Month Contract'
   AND duration_months IS NULL;

UPDATE payment_schedule_templates
   SET duration_months = 12
 WHERE tenant_id IS NULL
   AND name = 'Platform: 12-Month Contract'
   AND duration_months IS NULL;

-- Long Stay (15-60 nights) explicitly stays NULL — variable duration, uses
-- vacation-rental milestone semantics (30% deposit / 40% check-in / 30% mid-stay).

-- ---------------------------------------------------------------------------
-- 2. contract_invoices.is_deposit
-- ---------------------------------------------------------------------------

ALTER TABLE contract_invoices
  ADD COLUMN IF NOT EXISTS is_deposit BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN contract_invoices.is_deposit IS
  'TRUE when this invoice represents the refundable security deposit (separate from '
  'monthly rent). Excluded from total_value totals. Future refund/credit-note flow '
  'targets these rows specifically.';

-- Index for the future "deposits to refund" query (e.g. contracts in terminal state).
CREATE INDEX IF NOT EXISTS idx_ci_tenant_is_deposit
  ON contract_invoices (tenant_id, is_deposit)
  WHERE is_deposit = TRUE;

COMMIT;

-- Verification queries (commented out — run manually after deploy):
--
-- SELECT name, duration_months FROM payment_schedule_templates
--   WHERE tenant_id IS NULL ORDER BY duration_months NULLS LAST;
--
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--  WHERE table_name = 'contract_invoices' AND column_name = 'is_deposit';
