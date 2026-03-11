-- 012_drop_booking_range_exclude.sql
-- PR-SESSIONS-FIX: Remove the EXCLUDE USING GIST constraint on bookings.
--
-- Root cause: the production DB has an EXCLUDE constraint on
-- (tenant_id, resource_id, booking_range) that prevents two bookings
-- with overlapping time ranges from sharing the same resource.
-- This is correct for single-capacity services but BLOCKS the second
-- participant in a parallel/group service (e.g. Scramble) from joining
-- a session that already has a booking on the same resource+time slot.
--
-- Fix: drop the EXCLUDE constraint.
-- Conflict prevention is fully handled at application level by checkConflicts()
-- in utils/bookings.js, which correctly permits same-service parallel bookings
-- while blocking different-service resource conflicts.
--
-- Safe to run multiple times (DO block guards with IF FOUND check).

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  -- Find all EXCLUDE constraints on the bookings table.
  -- pg_constraint.contype = 'x' means EXCLUSION.
  SELECT conname
    INTO v_conname
    FROM pg_constraint
   WHERE conrelid = 'public.bookings'::regclass
     AND contype   = 'x'
   LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT IF EXISTS %I', v_conname);
    RAISE NOTICE 'Dropped EXCLUDE constraint % on bookings', v_conname;
  ELSE
    RAISE NOTICE 'No EXCLUDE constraint found on bookings – nothing to drop.';
  END IF;
END;
$$;

-- Also drop any GiST index on booking_range that only existed to support
-- the exclusion constraint.  If you rely on the GiST index for fast
-- overlap queries in availability.js keep it; this statement is safe
-- even if it doesn't exist.
--
-- Comment out the line below if you want to KEEP the GiST index for
-- query performance (the index itself is harmless without the constraint).
-- DROP INDEX IF EXISTS bookings_booking_range_excl;
