-- 009_service_hours_overnight.sql
-- Allow service_hours rows to use the same overnight rule as tenant_hours.
-- Examples now allowed:
--   20:00 -> 00:00
--   18:00 -> 02:00
-- Still blocked:
--   10:00 -> 10:00

ALTER TABLE service_hours
  DROP CONSTRAINT IF EXISTS chk_service_hours_order;

ALTER TABLE service_hours
  ADD CONSTRAINT chk_service_hours_nonzero CHECK (close_time <> open_time);
