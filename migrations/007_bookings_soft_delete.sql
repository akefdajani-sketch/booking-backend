-- 007_bookings_soft_delete.sql — PR-19
-- Adds soft-delete support to the bookings table.
-- Hard cancellation via DELETE is replaced by deleted_at stamping.
-- Existing status='cancelled' rows are unaffected — deleted_at stays NULL
-- (cancellation and deletion are distinct states).
--
-- Run: psql $DATABASE_URL -f migrations/007_bookings_soft_delete.sql

BEGIN;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Partial index: normal queries only touch non-deleted bookings
CREATE INDEX IF NOT EXISTS idx_bookings_active
  ON bookings (tenant_id, start_time)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_active_customer
  ON bookings (tenant_id, customer_id)
  WHERE deleted_at IS NULL;

COMMIT;
