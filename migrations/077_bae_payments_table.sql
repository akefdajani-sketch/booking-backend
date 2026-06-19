-- 077: bank_etihad_payments table — one row per Cybersource Unified Checkout attempt.
-- Mirrors migration 017 (network_payments) but tailored to the Cybersource flow:
--   - capture_context_id (Unified Checkout) replaces session_id / success_indicator (MPGS).
--   - Server-side payment-status verify against Cybersource fills transaction_id + status.
--   - No mpgs_result field — Cybersource status strings live in raw_response.
-- NO BEGIN/COMMIT — the migrate runner wraps each file in its own transaction. Idempotent.

CREATE TABLE IF NOT EXISTS bank_etihad_payments (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Booking reference (nullable — capture context is minted before the booking row exists).
  booking_id          INTEGER REFERENCES bookings(id) ON DELETE SET NULL,

  -- Merchant reference code (MRC). Unique per tenant.
  order_id            TEXT NOT NULL,

  -- Cybersource capture-context identifier returned by the SDK init call.
  capture_context_id  TEXT,

  -- Cybersource payment ID — set after server-side payment-status verify.
  transaction_id      TEXT,

  amount              NUMERIC(12,3) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'JOD',

  -- Status lifecycle: pending → completed | failed | refunded
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),

  -- Full Cybersource response stored for audit / support / reconciliation.
  raw_response        JSONB,

  -- Refund tracking
  refund_id           TEXT,
  refunded_at         TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-tenant uniqueness of the MRC. Also serves as the (tenant_id, order_id) lookup index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_etihad_payments_tenant_order
  ON bank_etihad_payments (tenant_id, order_id);

CREATE INDEX IF NOT EXISTS idx_bank_etihad_payments_booking
  ON bank_etihad_payments (booking_id)
  WHERE booking_id IS NOT NULL;

COMMENT ON TABLE  bank_etihad_payments                    IS 'One row per Cybersource Unified Checkout attempt (BAE white-label).';
COMMENT ON COLUMN bank_etihad_payments.order_id           IS 'Merchant reference code (MRC). Unique per tenant.';
COMMENT ON COLUMN bank_etihad_payments.capture_context_id IS 'Cybersource Unified Checkout capture-context identifier.';
COMMENT ON COLUMN bank_etihad_payments.transaction_id     IS 'Cybersource payment ID set after server-side payment-status verify.';
COMMENT ON COLUMN bank_etihad_payments.raw_response       IS 'Full Cybersource response payload (init + verify) for audit/reconciliation.';
