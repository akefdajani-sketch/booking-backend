-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 043: WhatsApp reminder dedup columns
--
-- Mirrors migration 042 (SMS reminder dedup) but for WhatsApp. Kept as
-- separate columns rather than shared with SMS so that a Pro tenant who
-- enables BOTH channels gets reminders on both (belt-and-suspenders — a
-- customer who misses SMS might catch WhatsApp and vice versa). Owners who
-- want to avoid duplicates can configure only one channel's credentials.
--
-- All statements idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS wa_reminder_sent_24h TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wa_reminder_sent_1h  TIMESTAMPTZ;

COMMENT ON COLUMN bookings.wa_reminder_sent_24h IS
  '24-hour WhatsApp reminder timestamp. Set by whatsappReminderEngine after successful send.';

COMMENT ON COLUMN bookings.wa_reminder_sent_1h IS
  '1-hour WhatsApp reminder timestamp. Same semantics as wa_reminder_sent_24h.';

CREATE INDEX IF NOT EXISTS idx_bookings_pending_wa_24h_reminder
  ON bookings (start_time)
  WHERE wa_reminder_sent_24h IS NULL
    AND status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_bookings_pending_wa_1h_reminder
  ON bookings (start_time)
  WHERE wa_reminder_sent_1h IS NULL
    AND status = 'confirmed';

COMMIT;
