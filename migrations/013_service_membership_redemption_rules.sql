-- 013_service_membership_redemption_rules.sql
-- Adds explicit per-service membership redemption controls.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS membership_redemption_mode text;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS membership_minutes_per_booking integer;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS membership_uses_per_booking integer;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS membership_redemption_notes text;

UPDATE services
SET membership_redemption_mode = COALESCE(NULLIF(TRIM(membership_redemption_mode), ''), 'auto')
WHERE membership_redemption_mode IS NULL OR NULLIF(TRIM(membership_redemption_mode), '') IS NULL;

ALTER TABLE services
  ALTER COLUMN membership_redemption_mode SET DEFAULT 'auto';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'services_membership_redemption_mode_check'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_membership_redemption_mode_check
      CHECK (membership_redemption_mode IN ('auto', 'minutes', 'uses'));
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'services_membership_minutes_per_booking_check'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_membership_minutes_per_booking_check
      CHECK (membership_minutes_per_booking IS NULL OR membership_minutes_per_booking > 0);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'services_membership_uses_per_booking_check'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_membership_uses_per_booking_check
      CHECK (membership_uses_per_booking IS NULL OR membership_uses_per_booking > 0);
  END IF;
END$$;
