-- migrations/017_network_payments.sql
-- PAY-1: Network International / MPGS payment integration
--
-- Adds:
--   1. network payment credential columns on tenants (nullable — not all tenants use Network)
--   2. network_payments table — one row per MPGS checkout attempt
--   3. payment_gateway column on tenant_invoices (stripe | network)
--   4. Indexes for fast lookup by order_id and tenant_id
--
-- All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- ─── 1. Network credentials on tenants ───────────────────────────────────────
-- Stored per-tenant so future enterprise tenants can use their own merchant account.
-- For now, all tenants share the platform merchant credentials from env vars.
-- These columns allow per-tenant overrides when needed.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS network_merchant_id   TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS network_gateway_url   TEXT;
-- NOTE: api_password is intentionally NOT stored in the DB.
--       Use env vars: NETWORK_MERCHANT_ID, NETWORK_API_PASSWORD, NETWORK_GATEWAY_URL
--       Per-tenant passwords (if needed) should go through a secrets manager.

-- ─── 2. Network payments table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network_payments (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Booking reference (nullable — payment may be initiated before booking is confirmed)
  booking_id          INTEGER REFERENCES bookings(id) ON DELETE SET NULL,

  -- MPGS order identifier (format: FLEXRZ-{slug}-{ref}-{timestamp})
  order_id            TEXT NOT NULL,

  -- MPGS session ID returned at checkout initiation
  session_id          TEXT NOT NULL,

  -- MPGS transaction ID (returned after payment, used for refunds)
  transaction_id      TEXT,

  -- successIndicator returned at session creation — compared against resultIndicator on return
  success_indicator   TEXT NOT NULL,

  -- Payment amount and currency
  amount              NUMERIC(12,3) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'JOD',

  -- Status lifecycle: pending → completed | failed | refunded
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),

  -- MPGS result: SUCCESS | FAILURE | PENDING_CHALLENGE etc.
  mpgs_result         TEXT,

  -- Full MPGS transaction response stored for audit / support
  raw_response        JSONB,

  -- Refund tracking
  refund_transaction_id TEXT,
  refunded_at         TIMESTAMPTZ,
  refund_raw_response JSONB,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_network_payments_tenant
  ON network_payments (tenant_id);

CREATE INDEX IF NOT EXISTS idx_network_payments_order_id
  ON network_payments (order_id);

CREATE INDEX IF NOT EXISTS idx_network_payments_booking
  ON network_payments (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_network_payments_status
  ON network_payments (tenant_id, status);

-- ─── 3. Add gateway column to tenant_invoices ─────────────────────────────────
-- Allows the invoices endpoint to show which gateway processed each payment.

ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS payment_gateway TEXT DEFAULT 'stripe';

-- ─── 4. Add network_payment_id to tenant_invoices ────────────────────────────

ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS network_payment_id INTEGER
  REFERENCES network_payments(id) ON DELETE SET NULL;
