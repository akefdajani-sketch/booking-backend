BEGIN;

-- PR-S1 (Staff Schedule)
-- IMPORTANT:
-- Your DB already contains weekly schedule in: staff_weekly_schedule
-- (tenant_id, staff_id, day_of_week, start_time, end_time, is_off, note).
-- This migration only adds the date-level exceptions table used by the
-- tenant dashboard "Exceptions" UI and the availability engine.

CREATE TABLE IF NOT EXISTS staff_schedule_overrides (
  id         SERIAL PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('OFF','CUSTOM_HOURS','ADD_HOURS')),
  start_time TIME NULL,
  end_time   TIME NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_overrides_time_chk CHECK (
    (type = 'OFF' AND start_time IS NULL AND end_time IS NULL)
    OR
    (type IN ('CUSTOM_HOURS','ADD_HOURS') AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  )
);

CREATE INDEX IF NOT EXISTS idx_staff_overrides_tenant_staff_date
  ON staff_schedule_overrides (tenant_id, staff_id, date);

CREATE INDEX IF NOT EXISTS idx_staff_overrides_tenant_date
  ON staff_schedule_overrides (tenant_id, date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_overrides_unique_block'
  ) THEN
    ALTER TABLE staff_schedule_overrides
      ADD CONSTRAINT staff_overrides_unique_block
      UNIQUE (tenant_id, staff_id, date, type, start_time, end_time);
  END IF;
END $$;

-- Ensure shared updated_at trigger function exists (if your DB already has it,
-- this is a no-op).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger AS $fn$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_staff_overrides_updated_at') THEN
    CREATE TRIGGER trg_staff_overrides_updated_at
    BEFORE UPDATE ON staff_schedule_overrides
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;
