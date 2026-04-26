-- migrations/050_contract_invoice_reminders_and_renewal.sql
-- G2a-S3d: Contract invoice WhatsApp reminders + contract renewal lineage.
--
-- Two independent additions, one idempotent migration. Safe to run against
-- production multiple times.
--
--   1. contract_invoices.reminder_sent_at — dedup column so each invoice
--      reminder fires at most once per invoice, regardless of how often the
--      reminder cron job runs.
--
--   2. contracts.parent_contract_id — optional lineage: when a contract is
--      renewed, the new contract's parent_contract_id points at the old
--      contract's id. Enables "contract history" queries and renewal chains.

BEGIN;

-- ─── 1. Reminder dedup on contract_invoices ────────────────────────────────

ALTER TABLE contract_invoices
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN contract_invoices.reminder_sent_at
  IS 'Timestamp of the last WhatsApp reminder send; NULL = never sent. G2a-S3d.';

-- Partial index for the reminder scan (invoices still owing attention)
CREATE INDEX IF NOT EXISTS idx_contract_invoices_reminder_scan
  ON contract_invoices (tenant_id, due_date)
  WHERE reminder_sent_at IS NULL
    AND status IN ('pending', 'sent');

-- ─── 2. Renewal lineage on contracts ───────────────────────────────────────

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS parent_contract_id BIGINT
    REFERENCES contracts(id) ON DELETE SET NULL;

COMMENT ON COLUMN contracts.parent_contract_id
  IS 'If this contract was created by renewing an earlier one, points to that contract. G2a-S3d.';

CREATE INDEX IF NOT EXISTS idx_contracts_parent
  ON contracts (parent_contract_id)
  WHERE parent_contract_id IS NOT NULL;

-- Record the migration
INSERT INTO schema_migrations (filename, applied_at)
VALUES ('050_contract_invoice_reminders_and_renewal.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
