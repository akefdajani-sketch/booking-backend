-- migrations/019_payment_methods.sql
-- PAY-2: Payment method tracking on bookings + per-tenant payment method settings
--
-- Adds:
--   1. payment_method column on bookings (card | cliq | cash | membership | package | free)
--   2. payment_settings JSONB on tenants — controls which methods the tenant allows
--
-- payment_settings shape stored in tenants.branding->>'paymentSettings' (JSONB):
--   {
--     "allow_card":  true,   -- Network card payments (default on)
--     "allow_cliq":  true,   -- Network Cliq payments (default on)
--     "allow_cash":  false   -- Cash (default off — tenant must enable)
--   }
--
-- payment_method values:
--   card        — paid via Network MPGS card
--   cliq        — paid via Network Cliq
--   cash        — cash (recorded by owner, no gateway)
--   membership  — covered by membership credits (charge_amount = 0)
--   package     — covered by prepaid package (charge_amount = 0)
--   free        — service has no price / explicitly free
--
-- All idempotent.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method TEXT
  CHECK (payment_method IN ('card','cliq','cash','membership','package','free'));

-- Back-fill existing bookings from what we already know
UPDATE bookings
SET payment_method =
  CASE
    WHEN customer_membership_id IS NOT NULL AND charge_amount = 0 THEN 'membership'
    WHEN charge_amount = 0 AND price_amount > 0 THEN 'package'
    WHEN price_amount IS NULL OR price_amount = 0 THEN 'free'
    ELSE NULL  -- unknown for old bookings, will be set going forward
  END
WHERE payment_method IS NULL;

-- Index for owner dashboard payment method filter
CREATE INDEX IF NOT EXISTS idx_bookings_payment_method
  ON bookings (tenant_id, payment_method)
  WHERE payment_method IS NOT NULL;
