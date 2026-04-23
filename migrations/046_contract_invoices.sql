-- migrations/046_contract_invoices.sql
-- G2a-1: Long-term contracts — per-milestone invoice rows.
--
-- One row per milestone from the contract's payment_schedule_snapshot.
-- Created as status='pending' when contract transitions to 'signed'.
-- Finalized/sent (→'sent') when Stripe Invoice is created and sent, OR
-- when a manual MPGS/cash flow starts tracking this invoice.
--
-- Status machine:
--   pending → sent → paid
--                 → partial → paid
--                 → void
--   pending → cancelled
--
-- Payment vocabulary aligned with rental_payment_links.paid_via:
--   payment_method IN ('card','cliq','cash','stripe','other')
--     card   = MPGS/Network International (MENA card processing)
--     cliq   = Jordanian instant bank transfer
--     cash   = rep records receipt
--     stripe = Stripe Checkout / Customer Portal
--     other  = bank wire, other manual
--
-- "Overdue" is a query, not a status:
--   WHERE status IN ('sent','partial') AND due_date < CURRENT_DATE
--
-- Fully idempotent.

CREATE TABLE IF NOT EXISTS contract_invoices (
  id                 BIGSERIAL    PRIMARY KEY,
  tenant_id          INTEGER      NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  contract_id        BIGINT       NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  milestone_index    INTEGER      NOT NULL,
  milestone_label    TEXT,

  amount             NUMERIC(12,3) NOT NULL,
  amount_paid        NUMERIC(12,3) NOT NULL DEFAULT 0,
  currency_code      TEXT          NOT NULL,

  status             TEXT          NOT NULL DEFAULT 'pending',
  due_date           DATE          NOT NULL,
  issued_at          TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  voided_at          TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,

  -- Stripe-specific (tracks the Stripe Invoice through its own draft→open→paid lifecycle)
  stripe_invoice_id  TEXT,

  -- Post-payment tracking (mirrors rental_payment_links.paid_via/payment_ref/payment_notes)
  payment_method     TEXT,
  payment_ref        TEXT,  -- MPGS order ID, Stripe charge ID, CliQ ref, cash receipt number
  payment_notes      TEXT,  -- free-form notes (e.g. cash receipt details)

  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_ci_contract_milestone
    UNIQUE (contract_id, milestone_index),
  CONSTRAINT chk_ci_status
    CHECK (status IN ('pending','sent','paid','partial','cancelled','void')),
  CONSTRAINT chk_ci_currency_len
    CHECK (length(currency_code) = 3),
  CONSTRAINT chk_ci_amount_nonneg
    CHECK (amount >= 0),
  CONSTRAINT chk_ci_amount_paid_bounded
    CHECK (amount_paid >= 0 AND amount_paid <= amount),
  CONSTRAINT chk_ci_payment_method
    CHECK (payment_method IS NULL
           OR payment_method IN ('card','cliq','cash','stripe','other')),
  CONSTRAINT chk_ci_paid_has_timestamp
    CHECK ((status <> 'paid') OR (paid_at IS NOT NULL AND amount_paid >= amount)),
  CONSTRAINT chk_ci_void_has_timestamp
    CHECK ((status <> 'void') OR (voided_at IS NOT NULL)),
  CONSTRAINT chk_ci_cancelled_has_timestamp
    CHECK ((status <> 'cancelled') OR (cancelled_at IS NOT NULL))
);

-- Partial unique: one stripe_invoice_id only matters when set.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ci_stripe_invoice_id
  ON contract_invoices (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ci_tenant_contract
  ON contract_invoices (tenant_id, contract_id);

-- Fast "what's overdue / due soon" queries + WhatsApp reminder scan.
CREATE INDEX IF NOT EXISTS idx_ci_tenant_due_date_open
  ON contract_invoices (tenant_id, due_date)
  WHERE status IN ('pending','sent','partial');

-- For dashboard "payments received this period" queries.
CREATE INDEX IF NOT EXISTS idx_ci_tenant_paid_at
  ON contract_invoices (tenant_id, paid_at DESC)
  WHERE status = 'paid';

COMMENT ON TABLE contract_invoices IS
  'G2a: One row per milestone from contracts.payment_schedule_snapshot. Created on contract sign, finalized/sent/paid across lifecycle.';
COMMENT ON COLUMN contract_invoices.stripe_invoice_id IS
  'Stripe Invoice ID. Separate from payment_ref because Stripe invoices have their own draft→open→paid lifecycle before payment.';
COMMENT ON COLUMN contract_invoices.payment_method IS
  'How the customer paid. Aligned with rental_payment_links.paid_via vocabulary.';
COMMENT ON COLUMN contract_invoices.payment_ref IS
  'Gateway txn ID (MPGS order ID, Stripe charge ID, CliQ ref, cash receipt number).';
COMMENT ON COLUMN contract_invoices.amount_paid IS
  'Cumulative amount received. Allows partial payments (status=partial until amount_paid >= amount).';
