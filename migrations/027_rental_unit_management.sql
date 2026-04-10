-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 027: Rental Unit Management
--
-- Adds building grouping and per-unit rental lifecycle management to resources.
-- All columns are optional — existing timeslot resources default to short_term
-- and are completely unaffected by this migration.
--
-- rental_type values:
--   short_term  = default. Nightly availability engine runs normally.
--   long_term   = unit is under an active lease. Blocked for all nightly
--                 bookings during the lease period.
--   flexible    = long-term lease that auto-releases for short-term nightly
--                 bookings after lease_end passes.
--
-- auto_release_on_expiry:
--   When true and rental_type = 'flexible', the availability engine
--   automatically treats the unit as short_term after lease_end.
--
-- NOTE: These columns already exist in the production database.
-- This migration is idempotent — safe to run against any environment.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── Building grouping ────────────────────────────────────────────────────────
-- Lightweight label to group units under a building.
-- No separate buildings table needed until scale requires it.
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS building_name   TEXT;

COMMENT ON COLUMN resources.building_name IS
  'Optional building or group label (e.g. "Building A", "Tower 1"). Used to group units on the dashboard.';

-- ─── Per-unit rental type ─────────────────────────────────────────────────────
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS rental_type  TEXT NOT NULL DEFAULT 'short_term'
    CONSTRAINT resources_rental_type_check
      CHECK (rental_type IN ('short_term', 'long_term', 'flexible'));

COMMENT ON COLUMN resources.rental_type IS
  'short_term = nightly only | long_term = under active lease | flexible = long_term that releases for short-term after lease_end';

-- ─── Long-term lease details ──────────────────────────────────────────────────
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS lease_start           DATE,
  ADD COLUMN IF NOT EXISTS lease_end             DATE,
  ADD COLUMN IF NOT EXISTS lease_tenant_name     TEXT,
  ADD COLUMN IF NOT EXISTS lease_tenant_phone    TEXT,
  ADD COLUMN IF NOT EXISTS monthly_rate          NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS auto_release_on_expiry BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN resources.lease_start            IS 'Start date of the active long-term lease.';
COMMENT ON COLUMN resources.lease_end              IS 'End date of the active long-term lease.';
COMMENT ON COLUMN resources.lease_tenant_name      IS 'Name of the current long-term tenant.';
COMMENT ON COLUMN resources.lease_tenant_phone     IS 'Phone number of the current long-term tenant.';
COMMENT ON COLUMN resources.monthly_rate           IS 'Monthly rental rate for the active lease.';
COMMENT ON COLUMN resources.auto_release_on_expiry IS 'When true and rental_type=flexible, unit opens for short-term nightly bookings after lease_end.';

-- ─── Indexes ─────────────────────────────────────────────────────────────────
-- Supports occupancy dashboard queries — filter by non-short-term units
CREATE INDEX IF NOT EXISTS idx_resources_rental_type
  ON resources (tenant_id, rental_type)
  WHERE rental_type != 'short_term';

-- Supports lease expiry queries (renewal reminders, auto-release logic)
CREATE INDEX IF NOT EXISTS idx_resources_lease_end
  ON resources (tenant_id, lease_end)
  WHERE lease_end IS NOT NULL;

COMMIT;
