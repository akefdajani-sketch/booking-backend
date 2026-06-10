-- Migration 074: Archive/Restore for staff, services, resources.
--
-- Adds archived_at / archived_by columns + partial-index-not-archived to
-- each of the three core entity tables. Archive is a THIRD state distinct
-- from is_active=false (which is already the soft-delete path used by
-- DELETE handlers when FK violations occur). DELETE routes are untouched.
--
-- Zero-behavior-change at ship: no rows archived, so every new
-- "AND archived_at IS NULL" clause is a no-op until someone archives.
--
-- Booking history joins (routes/bookings/history.js, routes/ai.js customer
-- bookings) join services/resources/staff by id with no is_active or
-- archived_at filter on the join -- archived names keep rendering.
--
-- Restore = single UPDATE setting archived_at=NULL.
--
-- ---- IDEMPOTENCY -----------------------------------------------------------
-- ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS are both
-- re-runnable. NO inner BEGIN/COMMIT -- the migration runner outer-wraps
-- this file (per migrate_runner_nested_tx convention).
--
-- ---- ROLLBACK --------------------------------------------------------------
-- ALTER TABLE staff     DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS archived_by;
-- ALTER TABLE services  DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS archived_by;
-- ALTER TABLE resources DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS archived_by;
-- (indexes drop with the columns.)

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS archived_by TEXT        DEFAULT NULL;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS archived_by TEXT        DEFAULT NULL;

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS archived_by TEXT        DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_not_archived
  ON staff (tenant_id) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_services_not_archived
  ON services (tenant_id) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_resources_not_archived
  ON resources (tenant_id) WHERE archived_at IS NULL;

COMMENT ON COLUMN staff.archived_at     IS 'Archive sentinel (074). Suppressed by list/discovery queries; restore = set NULL.';
COMMENT ON COLUMN services.archived_at  IS 'Archive sentinel (074). Suppressed by list/discovery queries; restore = set NULL.';
COMMENT ON COLUMN resources.archived_at IS 'Archive sentinel (074). Suppressed by list/discovery queries; restore = set NULL.';
