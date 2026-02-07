BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS staff_schedules (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday      SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   SMALLINT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_schedules_minutes_order_chk CHECK (end_minute > start_minute)
);

CREATE INDEX IF NOT EXISTS idx_staff_schedules_tenant_staff
  ON staff_schedules (tenant_id, staff_id);

CREATE INDEX IF NOT EXISTS idx_staff_schedules_tenant_staff_weekday
  ON staff_schedules (tenant_id, staff_id, weekday);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_schedules_no_overlap_excl'
  ) THEN
    ALTER TABLE staff_schedules
      ADD CONSTRAINT staff_schedules_no_overlap_excl
      EXCLUDE USING gist (
        tenant_id WITH =,
        staff_id WITH =,
        weekday WITH =,
        int4range(start_minute, end_minute, '[)') WITH &&
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS staff_schedule_overrides (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('OFF','CUSTOM_HOURS','ADD_HOURS')),
  start_minute SMALLINT NULL,
  end_minute   SMALLINT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_overrides_minutes_chk CHECK (
    (type = 'OFF' AND start_minute IS NULL AND end_minute IS NULL)
    OR
    (type IN ('CUSTOM_HOURS','ADD_HOURS')
      AND start_minute BETWEEN 0 AND 1439
      AND end_minute BETWEEN 1 AND 1440
      AND end_minute > start_minute
    )
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
      UNIQUE (tenant_id, staff_id, date, type, start_minute, end_minute);
  END IF;
END $$;

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
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_staff_schedules_updated_at') THEN
    CREATE TRIGGER trg_staff_schedules_updated_at
    BEFORE UPDATE ON staff_schedules
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_staff_overrides_updated_at') THEN
    CREATE TRIGGER trg_staff_overrides_updated_at
    BEFORE UPDATE ON staff_schedule_overrides
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;
