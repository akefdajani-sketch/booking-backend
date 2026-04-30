-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 057: Contract Invoice Payment Links
--
-- Backs the routes/contractInvoicePaymentLinks.js and
-- utils/contractInvoicePaymentLinks.js modules. Mirrors rental_payment_links
-- (migration 028) but for contract_invoices.
--
-- Each contract invoice can have one PENDING link at a time (enforced by
-- partial unique index uq_cipl_pending_per_invoice). Reminder cron and
-- contract-sign hooks both call getOrCreatePendingLink() which returns the
-- existing pending row when it exists, so all reminders for the same invoice
-- carry the same token.
--
-- Public portal URL format:
--   https://app.flexrz.com/pay-invoice/{token}
--
-- Payment methods supported:
--   card  = Network International MPGS (redirect to gateway)
--   cliq  = CliQ / instant bank transfer (rep records receipt)
--   cash  = Cash (rep records receipt)
--
-- Status lifecycle:
--   pending   → link generated, not yet paid
--   paid      → invoice fully paid (LINK row also flips to 'paid')
--   expired   → expires_at passed without payment (auto on /public/:token GET)
--   cancelled → manually cancelled by owner (PATCH endpoint)
--
-- NOTE: partial payments leave the LINK status='pending'. Only the underlying
-- contract_invoice carries the partial state. The link flips to 'paid' only
-- when the invoice fully clears.
--
-- Idempotent: every CREATE uses IF NOT EXISTS. Safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS contract_invoice_payment_links (
  id                    BIGSERIAL     PRIMARY KEY,
  tenant_id             BIGINT        NOT NULL REFERENCES tenants(id)           ON DELETE CASCADE,
  contract_invoice_id   BIGINT        NOT NULL REFERENCES contract_invoices(id) ON DELETE CASCADE,

  -- Public token used in the portal URL: /pay-invoice/{token}
  -- gen_random_uuid requires the pgcrypto extension, which is already enabled
  -- (rental_payment_links uses it too).
  token                 TEXT          NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,

  -- Snapshot at link creation. The invoice is the source of truth for actual
  -- amount/currency; this column captures what was requested when the link
  -- was made (useful for audit if invoice.amount is later edited).
  amount_requested      NUMERIC(12,3) NOT NULL,
  currency_code         TEXT          NOT NULL,

  -- Status
  status                TEXT          NOT NULL DEFAULT 'pending'
                          CONSTRAINT contract_invoice_payment_links_status_check
                          CHECK (status IN ('pending','paid','expired','cancelled')),

  -- Lifecycle timestamps. Each ends up populated when the link transitions.
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  expired_at            TIMESTAMPTZ
);

-- Fast token lookup for the public portal.
CREATE INDEX IF NOT EXISTS idx_cipl_token
  ON contract_invoice_payment_links (token);

-- Tenant + invoice lookups (owner side: list links for an invoice).
CREATE INDEX IF NOT EXISTS idx_cipl_invoice
  ON contract_invoice_payment_links (contract_invoice_id);

CREATE INDEX IF NOT EXISTS idx_cipl_tenant_created
  ON contract_invoice_payment_links (tenant_id, created_at DESC);

-- Pending sweep query (cron hits this in /expire-sweep).
CREATE INDEX IF NOT EXISTS idx_cipl_pending_expiry
  ON contract_invoice_payment_links (tenant_id, status, expires_at)
  WHERE status = 'pending';

-- The partial unique index that enforces "at most one PENDING link per
-- invoice." Lets getOrCreatePendingLink be race-safe — concurrent inserts
-- conflict and the loser re-selects the winner's row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cipl_pending_per_invoice
  ON contract_invoice_payment_links (contract_invoice_id)
  WHERE status = 'pending';

COMMIT;

-- Verification query (commented — run manually after deploy):
--
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'contract_invoice_payment_links'
--  ORDER BY ordinal_position;
