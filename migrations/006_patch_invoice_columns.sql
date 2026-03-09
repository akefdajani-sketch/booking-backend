-- 006_patch_invoice_columns.sql
-- PR-9 patch: add missing columns and unique constraints to existing tables.
-- Run this instead of / after the failed 006 migration.
-- All statements are idempotent — safe to re-run.

-- ─── tenant_invoices: add missing columns ─────────────────────────────────────
ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS subscription_id   INTEGER REFERENCES tenant_subscriptions(id) ON DELETE SET NULL;
ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT;
ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS amount_cents      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS currency          TEXT    NOT NULL DEFAULT 'usd';
ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS status            TEXT    NOT NULL DEFAULT 'open';
ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ;
ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ─── tenant_invoices: unique constraint (column must exist first) ─────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_invoices_stripe_invoice_id_key'
  ) THEN
    ALTER TABLE tenant_invoices
      ADD CONSTRAINT tenant_invoices_stripe_invoice_id_key
      UNIQUE (stripe_invoice_id);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_tenant_invoices_tenant
  ON tenant_invoices (tenant_id, created_at DESC);

-- ─── tenant_payments: add missing columns ─────────────────────────────────────
ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS provider_payment_intent_id TEXT;
ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS provider_charge_id          TEXT;
ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS failure_reason              TEXT;
ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ─── tenant_payments: unique constraint ───────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_payments_provider_payment_intent_id_key'
  ) THEN
    ALTER TABLE tenant_payments
      ADD CONSTRAINT tenant_payments_provider_payment_intent_id_key
      UNIQUE (provider_payment_intent_id);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_tenant_payments_tenant
  ON tenant_payments (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_payments_invoice
  ON tenant_payments (invoice_id);
