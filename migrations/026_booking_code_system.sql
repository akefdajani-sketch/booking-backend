-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 026: Booking Code System
--
-- Adds per-tenant booking code configuration to support a clean, human-readable
-- booking reference format:
--
--   {PREFIX}-{TYPE}-{YYMMDD}-{SEQ4}
--
-- Examples:
--   BRD-TS-260226-0079   (Birdie Golf, timeslot, 26 Feb 2026, sequence 79)
--   AQB-NT-260415-0001   (Aqaba Booking, nightly, 15 Apr 2026, sequence 1)
--
-- TYPE codes:
--   TS = time_slots booking
--   NT = nightly rental booking
--   LS = long-term lease (future)
--
-- booking_code_prefix: set by the tenant owner in General Settings (2–4 chars).
--   Fallback: first 3 chars of tenant slug if not set.
--
-- booking_seq: atomic ever-incrementing counter per tenant.
--   Updated via: UPDATE tenants SET booking_seq = booking_seq + 1
--                WHERE id = $1 RETURNING booking_seq
--   inside the booking creation transaction — never resets, never gaps.
--
-- NOTE: These columns already exist in the production database.
-- This migration is idempotent — safe to run against any environment.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS booking_code_prefix  TEXT,
  ADD COLUMN IF NOT EXISTS booking_seq          INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN tenants.booking_code_prefix IS
  'Short human-readable prefix for booking codes (2–4 uppercase chars). Set by owner in General Settings. Fallback: first 3 chars of slug.';

COMMENT ON COLUMN tenants.booking_seq IS
  'Atomic per-tenant ever-incrementing counter. Incremented inside booking creation transaction. Never resets.';

-- Seed known production tenants with sensible defaults
UPDATE tenants SET booking_code_prefix = 'BRD' WHERE slug = 'birdie-golf'    AND (booking_code_prefix IS NULL OR booking_code_prefix = '');
UPDATE tenants SET booking_code_prefix = 'AQB' WHERE slug = 'aqababooking'   AND (booking_code_prefix IS NULL OR booking_code_prefix = '');
UPDATE tenants SET booking_code_prefix = 'ALR' WHERE slug = 'alrazi'         AND (booking_code_prefix IS NULL OR booking_code_prefix = '');
UPDATE tenants SET booking_code_prefix = 'EXH' WHERE slug = 'exhalefit'      AND (booking_code_prefix IS NULL OR booking_code_prefix = '');

-- Index for fast lookup by booking code (used in WhatsApp/email reference lookups)
CREATE INDEX IF NOT EXISTS idx_bookings_code
  ON bookings (booking_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_code_tenant
  ON bookings (tenant_id, booking_code)
  WHERE booking_code IS NOT NULL;

COMMIT;
