-- migrations/047_bookings_contract_link.sql
-- G2a-1: Link bookings to contracts + add stay_type classification.
--
-- A booking can be linked to one contract (long-stay + contract-stay
-- bookings). Nightly bookings typically have contract_id IS NULL.
--
-- stay_type classifies a booking's duration tier for billing workflow:
--   nightly       — 1-14 nights  (no contract)
--   long_stay     — 15-60 nights (optional contract; tenant opts in)
--   contract_stay — 61+ nights   (contract workflow by default)
--
-- stay_type is only meaningful for booking_mode='nightly' bookings.
-- Time-slot bookings carry stay_type = NULL.
--
-- Derivation happens in utils/bookings.js at INSERT and when nights_count
-- changes. stay_type is PERSISTED (not recomputed on read) so indexes work.
--
-- Fully idempotent.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS contract_id  BIGINT  REFERENCES contracts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stay_type    TEXT;

-- Only nightly bookings can carry a stay_type value.
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS chk_bookings_stay_type;
ALTER TABLE bookings
  ADD CONSTRAINT chk_bookings_stay_type
  CHECK (
    stay_type IS NULL
    OR (stay_type IN ('nightly','long_stay','contract_stay')
        AND booking_mode = 'nightly')
  );

-- Find bookings attached to a contract (resource utilization, contract page).
CREATE INDEX IF NOT EXISTS idx_bookings_contract_id
  ON bookings (contract_id)
  WHERE contract_id IS NOT NULL;

-- Filter by stay tier for dashboard (e.g. "long-stay revenue this month").
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_stay_type
  ON bookings (tenant_id, stay_type)
  WHERE stay_type IS NOT NULL;

COMMENT ON COLUMN bookings.contract_id IS
  'G2a: FK to contracts.id when this booking is part of a long-term contract. NULL for standard nightly/time-slot bookings.';
COMMENT ON COLUMN bookings.stay_type IS
  'G2a: nightly (<=14) | long_stay (15-60) | contract_stay (61+). NULL for time-slot bookings. Derived from nights_count, persisted.';
