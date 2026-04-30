-- migrations/058_contract_invoice_reminder_windows.sql
-- G2-PL-4: Three-window reminder dedup for contract invoices.
--
-- The pre-G2-PL-4 reminder cron used a single column (reminder_sent_at)
-- which meant each invoice got AT MOST ONE reminder ever. Customers who
-- ignored the T-3 reminder never heard about the invoice again.
--
-- This migration adds three independent dedup timestamps so the cron can
-- fire once at each of three windows:
--
--   reminder_t3_sent_at      — fired 3 days before due_date
--   reminder_due_sent_at     — fired on due_date
--   reminder_overdue_sent_at — fired N days after due_date (default 5)
--
-- The legacy reminder_sent_at column is preserved (not dropped) for backward
-- compat and to give us a clean migration of historical data: any invoice
-- with reminder_sent_at IS NOT NULL is treated as "T-3 already fired" by
-- the new engine on first run, so we don't double-send to customers who
-- received the old single-window reminder.
--
-- Sign-time confirmation gets its own column too:
--   sign_notification_sent_at — fired immediately after contract → signed
--
-- All columns are NULLABLE TIMESTAMPTZ. The reminder engine sets them to
-- NOW() after a successful send, then skips that window on subsequent runs.
--
-- Fully idempotent.

BEGIN;

ALTER TABLE contract_invoices
  ADD COLUMN IF NOT EXISTS reminder_t3_sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_due_sent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_overdue_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sign_notification_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN contract_invoices.reminder_t3_sent_at IS
  'G2-PL-4: timestamp the T-3 day reminder was successfully dispatched (WA + SMS). NULL = not yet sent. Independent from reminder_due_sent_at and reminder_overdue_sent_at.';
COMMENT ON COLUMN contract_invoices.reminder_due_sent_at IS
  'G2-PL-4: timestamp the on-due-date reminder was dispatched. NULL = not yet sent.';
COMMENT ON COLUMN contract_invoices.reminder_overdue_sent_at IS
  'G2-PL-4: timestamp the overdue reminder was dispatched. NULL = not yet sent. Cron fires this 5 days after due_date by default.';
COMMENT ON COLUMN contract_invoices.sign_notification_sent_at IS
  'G2-PL-4: timestamp the contract-sign notification (with first invoice payment link) was dispatched. NULL = not yet sent. Set on first invoice of newly-signed contracts only.';

-- Backfill: treat any pre-G2-PL-4 reminder as a T-3 send so we don't
-- re-send the T-3 to customers who got the old single-window one.
-- Guard: only run if reminder_sent_at exists (it should — added in
-- migration 050 — but cheap to make this defensive).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contract_invoices'
      AND column_name = 'reminder_sent_at'
  ) THEN
    UPDATE contract_invoices
       SET reminder_t3_sent_at = reminder_sent_at
     WHERE reminder_sent_at IS NOT NULL
       AND reminder_t3_sent_at IS NULL;
  END IF;
END$$;

-- Indexes for the three reminder window queries. Each query in the engine
-- looks for "invoices in window X with reminder_X_sent_at IS NULL", so a
-- partial index on each NULL state speeds the cron significantly.
CREATE INDEX IF NOT EXISTS idx_ci_reminder_t3_pending
  ON contract_invoices (due_date)
  WHERE reminder_t3_sent_at IS NULL AND status IN ('pending','sent','partial');

CREATE INDEX IF NOT EXISTS idx_ci_reminder_due_pending
  ON contract_invoices (due_date)
  WHERE reminder_due_sent_at IS NULL AND status IN ('pending','sent','partial');

CREATE INDEX IF NOT EXISTS idx_ci_reminder_overdue_pending
  ON contract_invoices (due_date)
  WHERE reminder_overdue_sent_at IS NULL AND status IN ('pending','sent','partial');

COMMIT;
