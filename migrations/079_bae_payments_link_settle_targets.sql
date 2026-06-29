-- 079: BAE payment link settlement targets.
-- PR-6a: extends bank_etihad_payments so /complete can settle a rental_payment_link
-- or a contract_invoice_payment_link, not just a booking. Two new nullable TEXT
-- columns hold the link token at /initiate time; the existing booking_id stays
-- the booking-flow target. A CHECK enforces "at most one settlement target" so
-- a single payment row can never accidentally settle two things.
--
-- NO BEGIN/COMMIT — same convention as 077/078. The migrate runner (or DBeaver
-- when applied manually) wraps execution. Additive + idempotent: ADD COLUMN IF
-- NOT EXISTS, CREATE INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before
-- re-adding. Columns first, constraints after.

-- Columns first.
ALTER TABLE bank_etihad_payments
  ADD COLUMN IF NOT EXISTS rental_payment_link_token   TEXT;

ALTER TABLE bank_etihad_payments
  ADD COLUMN IF NOT EXISTS contract_invoice_link_token TEXT;

-- Partial indexes — used by /complete to look up the settlement target off
-- the row, and by future reconciler scans that filter to link-bound payments.
CREATE INDEX IF NOT EXISTS idx_bae_payments_rental_link
  ON bank_etihad_payments (rental_payment_link_token)
  WHERE rental_payment_link_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bae_payments_invoice_link
  ON bank_etihad_payments (contract_invoice_link_token)
  WHERE contract_invoice_link_token IS NOT NULL;

-- Then the exclusivity constraint. At most one settlement target per row.
-- All-NULL is allowed: the booking flow runs /initiate BEFORE the booking row
-- exists (booking_id is back-edged later); that transient state must remain
-- legal. The CHECK forbids the impossible state (two targets), not the
-- pre-link transient.
ALTER TABLE bank_etihad_payments
  DROP CONSTRAINT IF EXISTS chk_bae_settle_target_exclusive;

ALTER TABLE bank_etihad_payments
  ADD CONSTRAINT chk_bae_settle_target_exclusive
  CHECK (
    (booking_id IS NOT NULL)::int +
    (rental_payment_link_token IS NOT NULL)::int +
    (contract_invoice_link_token IS NOT NULL)::int <= 1
  );

COMMENT ON COLUMN bank_etihad_payments.rental_payment_link_token IS
  'PR-6a: token of the rental_payment_link this BAE payment settles. Set at /initiate when invoked from /pay/[token]. Mutually exclusive with booking_id and contract_invoice_link_token via chk_bae_settle_target_exclusive.';

COMMENT ON COLUMN bank_etihad_payments.contract_invoice_link_token IS
  'PR-6a: token of the contract_invoice_payment_link this BAE payment settles. Set at /initiate when invoked from /pay-invoice/[token]. Mutually exclusive with booking_id and rental_payment_link_token via chk_bae_settle_target_exclusive.';
