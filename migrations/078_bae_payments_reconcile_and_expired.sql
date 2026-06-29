-- 078: BAE payment state machine integrity.
-- Adds:
--   1. needs_reconcile flag — set when /complete records an AUTHORIZED payment
--      but the matching booking is either gone (swept by the 2c hold sweep) or
--      never linked (orphan: booking_id NULL). Orthogonal to status: status
--      stays 'completed' (truthful — money DID authorize at Cybersource);
--      needs_reconcile flags the no-booking defect for human reconciliation.
--   2. 'expired' status value — set by the 2c hold sweep on payment rows whose
--      paired booking just got cancelled, so pending payment rows never linger
--      after their booking is gone.
--
-- NO BEGIN/COMMIT — the migrate runner wraps each file in its own transaction.
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS
-- before re-adding, CREATE INDEX IF NOT EXISTS.

-- Columns first.
ALTER TABLE bank_etihad_payments
  ADD COLUMN IF NOT EXISTS needs_reconcile BOOLEAN NOT NULL DEFAULT false;

-- Then constraints. 077's inline CHECK was auto-named
-- bank_etihad_payments_status_check by Postgres; drop and re-add with 'expired'.
ALTER TABLE bank_etihad_payments
  DROP CONSTRAINT IF EXISTS bank_etihad_payments_status_check;
ALTER TABLE bank_etihad_payments
  ADD CONSTRAINT bank_etihad_payments_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'refunded', 'expired'));

-- Reconciler scan: "AUTHORIZED payments with no confirmed booking, per tenant,
-- newest first". Partial index keeps it tiny — only the defect rows.
CREATE INDEX IF NOT EXISTS idx_bank_etihad_payments_needs_reconcile
  ON bank_etihad_payments (tenant_id, created_at DESC)
  WHERE needs_reconcile;

COMMENT ON COLUMN bank_etihad_payments.needs_reconcile IS
  'TRUE when /complete recorded an AUTHORIZED payment but no booking was confirmed (swept or orphan). Requires human reconciliation. Orthogonal to status.';
