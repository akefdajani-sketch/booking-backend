-- 010_service_min_slots.sql
-- PR-SH2: Minimum consecutive slots per service.
-- Allows owners to set a minimum booking length (e.g. Karaoke = min 2 slots).
-- Null = no minimum (defaults to 1 slot, existing behavior preserved).

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS min_consecutive_slots INTEGER DEFAULT NULL;

COMMENT ON COLUMN services.min_consecutive_slots IS
  'Minimum number of consecutive slots required for a booking. NULL = 1 slot minimum (unrestricted).';
