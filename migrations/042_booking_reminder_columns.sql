-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 042: Booking reminder dedup columns
--
-- Adds two TIMESTAMPTZ columns to bookings that track when SMS reminders were
-- sent. The SMS reminder engine (H3.5.2) uses these as dedup guards — a booking
-- with a non-null reminder_sent_24h won't get a second 24h reminder even if
-- the cron runs multiple times while the booking is in the eligible window.
--
-- Why columns on bookings (not a separate notification_log table):
--   - Only two reminder types per booking — cheap to store inline
--   - Natural TTL — when the booking is deleted, its reminder state goes with it
--   - No joins in the reminder query — keeps the cron iteration fast
--   - Matches the simplicity of payment_link_reminders but without an extra table
--
-- All statements idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_sent_24h TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_sent_1h  TIMESTAMPTZ;

COMMENT ON COLUMN bookings.reminder_sent_24h IS
  '24-hour reminder timestamp. Set by smsReminderEngine after successful SMS send. NULL = not yet sent (or send failed, will retry).';

COMMENT ON COLUMN bookings.reminder_sent_1h IS
  '1-hour reminder timestamp. Same semantics as reminder_sent_24h but for the 1h window.';

-- Partial indexes — only on upcoming bookings where a reminder still might
-- need to fire. Keeps index size tiny even on large booking tables.
CREATE INDEX IF NOT EXISTS idx_bookings_pending_24h_reminder
  ON bookings (start_time)
  WHERE reminder_sent_24h IS NULL
    AND status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_bookings_pending_1h_reminder
  ON bookings (start_time)
  WHERE reminder_sent_1h IS NULL
    AND status = 'confirmed';

COMMIT;
