-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 028: Rental Payment Links
--
-- Adds a payment link system for rental bookings. Each booking can have one
-- or more payment links generated. A payment link:
--   - Has a unique token (UUID) used in the public URL
--   - Records the amount requested and any partial payments
--   - Tracks expiry, payment status, and who generated it
--   - Is linked to both the booking and the tenant for isolation
--
-- Public portal URL format:
--   https://app.flexrz.com/pay/{token}
--
-- Payment methods supported:
--   card  = Network International MPGS (redirect to gateway)
--   cliq  = CliQ / instant bank transfer (show account details)
--   cash  = Cash (rep records receipt)
--
-- Status lifecycle:
--   pending  → link generated, not yet paid
--   paid     → full amount received
--   partial  → partial amount received (for installments)
--   expired  → expiry_at passed without payment
--   cancelled → manually cancelled by owner/rep
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS rental_payment_links (
  id              BIGSERIAL     PRIMARY KEY,
  tenant_id       BIGINT        NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  booking_id      BIGINT        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

  -- The public token — used in the payment portal URL
  -- Format: /pay/{token}
  token           TEXT          NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,

  -- What is being requested
  amount_requested  NUMERIC(12,3) NOT NULL,
  amount_paid       NUMERIC(12,3) NOT NULL DEFAULT 0,
  currency_code     TEXT          NOT NULL DEFAULT 'JOD',

  -- Status
  status          TEXT          NOT NULL DEFAULT 'pending'
                    CONSTRAINT rental_payment_links_status_check
                    CHECK (status IN ('pending','paid','partial','expired','cancelled')),

  -- Allowed payment methods for this link (JSON array: ["card","cliq","cash"])
  -- NULL = all methods enabled
  allowed_methods JSONB,

  -- Optional description shown on the payment portal
  description     TEXT,

  -- Who created this link and when
  created_by_name  TEXT,        -- name of the rep/owner who created it
  created_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Expiry — NULL = never expires
  expires_at       TIMESTAMPTZ,

  -- Payment tracking
  paid_at          TIMESTAMPTZ,
  paid_via         TEXT,        -- 'card' | 'cliq' | 'cash'
  payment_ref      TEXT,        -- MPGS order ID, CliQ ref, or cash receipt number
  payment_notes    TEXT,        -- rep notes for cash payments

  -- WhatsApp tracking
  whatsapp_sent_at     TIMESTAMPTZ,
  whatsapp_sent_to     TEXT,        -- phone number it was sent to
  whatsapp_message_id  TEXT         -- Meta API message ID for delivery tracking
);

-- Fast lookup by token (public portal)
CREATE INDEX IF NOT EXISTS idx_rental_payment_links_token
  ON rental_payment_links (token);

-- Tenant + booking lookups (owner dashboard)
CREATE INDEX IF NOT EXISTS idx_rental_payment_links_booking
  ON rental_payment_links (booking_id);

CREATE INDEX IF NOT EXISTS idx_rental_payment_links_tenant
  ON rental_payment_links (tenant_id, created_at DESC);

-- Pending links query (for reminders)
CREATE INDEX IF NOT EXISTS idx_rental_payment_links_pending
  ON rental_payment_links (tenant_id, status, expires_at)
  WHERE status = 'pending';

-- updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rental_payment_links_updated_at'
  ) THEN
    CREATE TRIGGER trg_rental_payment_links_updated_at
      BEFORE UPDATE ON rental_payment_links
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END$$;

COMMIT;
