-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 061: Mark services as long-term with explicit boolean
--
-- Replaces the fragile `WHERE LOWER(name) LIKE '%long%'` heuristic in
-- utils/contracts.js → materializeContractBooking with an explicit column.
--
-- The heuristic worked fine for Aqaba's "Long Term" service (id 72) but
-- fails silently if anyone renames the service to "Extended Stay" or
-- "Monthly Rental" — the lookup falls back to the lowest-id nightly
-- service (Aqaba's "Short Term", id 54), and contracts get attributed to
-- the wrong service silently.
--
-- This migration:
--   1. Adds `services.is_long_term BOOLEAN NOT NULL DEFAULT FALSE`
--   2. Backfills existing data by checking whether name contains 'long'
--      (case-insensitive) — preserves current behavior for tenants who
--      already have correct naming.
--   3. Adds an index for the lookup query.
--
-- After this migration, owners can flip the flag from the services setup
-- tab without depending on the service name (frontend support is a
-- follow-up — for now ak can flip it directly via SQL or via Setup tab
-- if the toggle is added).
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Add the column.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS is_long_term BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Backfill: any nightly service whose name contains 'long' (case-insensitive)
--    gets is_long_term = TRUE. This preserves the current heuristic's behavior
--    for existing data so the cutover from name-LIKE to is_long_term flag is
--    invisible to tenants whose services are correctly named.
--
--    Only runs the UPDATE if there are nightly services not yet flagged —
--    keeps re-run idempotency clean (no rows changed on second run).
DO $$
DECLARE
  candidates INTEGER;
BEGIN
  SELECT COUNT(*) INTO candidates
    FROM services
   WHERE booking_mode = 'nightly'
     AND LOWER(name) LIKE '%long%'
     AND is_long_term = FALSE;

  IF candidates > 0 THEN
    RAISE NOTICE '[061] Backfilling is_long_term=TRUE for % nightly services with "long" in name', candidates;
    UPDATE services
       SET is_long_term = TRUE
     WHERE booking_mode = 'nightly'
       AND LOWER(name) LIKE '%long%'
       AND is_long_term = FALSE;
  END IF;
END $$;

-- 3. Index to make the lookup fast. Partial index — only the rare TRUE rows
--    need indexing, since the lookup query filters on is_long_term = TRUE.
CREATE INDEX IF NOT EXISTS idx_services_long_term_lookup
  ON services (tenant_id, booking_mode)
  WHERE is_long_term = TRUE;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries:
--
-- -- Check column was added
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'services' AND column_name = 'is_long_term';
--
-- -- Verify backfill worked for Aqaba (slug aqababooking, tenant_id 33).
-- -- Expect: "Long Term" service shows is_long_term=true; "Short Term"
-- -- shows is_long_term=false.
-- SELECT id, name, booking_mode, is_long_term
--   FROM services
--  WHERE tenant_id = 33
--  ORDER BY id;
-- ─────────────────────────────────────────────────────────────────────────────
