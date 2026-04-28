-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 055: Customer booking emails — toggles + reminder stamps
--
-- PR H (Customer booking emails). This wires the existing 'email_reminders'
-- saas_plans feature flag into the actual notification system. Until H, the
-- feature was advertised on the pricing page (Growth+) but never implemented.
--
-- Two additive changes:
--
--   1. tenants.email_*_enabled (4 BOOLEAN) — per-tenant per-event toggles
--      mirroring the SMS/WA toggles from migration 052. All DEFAULT TRUE so
--      existing tenants on Growth+ start receiving customer emails immediately
--      after deploy without owner intervention.
--
--   2. bookings.email_reminder_sent_24h / _1h (2 TIMESTAMPTZ) — dedup stamps
--      mirroring SMS migration 042 and WA migration 043. Gives the email
--      reminder engine the same "send once per booking per window" guarantee.
--
-- Idempotent. No data migration; pure schema additions.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Tenant-level email toggles ─────────────────────────────────────────────

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS email_confirmations_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_reminder_24h_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_reminder_1h_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_cancellations_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN tenants.email_confirmations_enabled IS
  'Per-tenant toggle for booking-confirmation email. Composed with email_reminders feature + RESEND_API_KEY at send time.';
COMMENT ON COLUMN tenants.email_reminder_24h_enabled IS
  '24-hour booking reminder email toggle. Default TRUE.';
COMMENT ON COLUMN tenants.email_reminder_1h_enabled IS
  '1-hour booking reminder email toggle. Default TRUE.';
COMMENT ON COLUMN tenants.email_cancellations_enabled IS
  'Cancellation-notice email toggle. Default TRUE.';

-- ── Per-booking email reminder dedup stamps ────────────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS email_reminder_sent_24h TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_reminder_sent_1h  TIMESTAMPTZ;

COMMENT ON COLUMN bookings.email_reminder_sent_24h IS
  'Timestamp when the 24h email reminder was sent for this booking. NULL = not yet sent. Mirrors reminder_sent_24h (SMS) and wa_reminder_sent_24h (WhatsApp).';
COMMENT ON COLUMN bookings.email_reminder_sent_1h IS
  '1-hour email reminder send timestamp. Same semantics as email_reminder_sent_24h.';

-- Partial indexes — same pattern as SMS migration 042 — to make the reminder
-- engine query (status=confirmed AND email_reminder_sent_X IS NULL) hit a
-- tiny pre-filtered index instead of scanning all bookings.

CREATE INDEX IF NOT EXISTS idx_bookings_email_reminder_pending_24h
  ON bookings (start_time)
  WHERE status = 'confirmed' AND email_reminder_sent_24h IS NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_email_reminder_pending_1h
  ON bookings (start_time)
  WHERE status = 'confirmed' AND email_reminder_sent_1h IS NULL;

COMMIT;

-- Verification:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'tenants' AND column_name LIKE 'email_%_enabled';
-- Expected: 4 rows.
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'bookings' AND column_name LIKE 'email_reminder_sent_%';
-- Expected: 2 rows.
