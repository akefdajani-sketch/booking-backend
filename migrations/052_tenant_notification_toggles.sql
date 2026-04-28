-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 052: Per-tenant notification toggle matrix
--
-- PR D5 (Per-tenant notification toggle matrix).
--
-- Adds 8 BOOLEAN columns to tenants: 4 SMS event toggles + 4 WhatsApp event
-- toggles. All DEFAULT TRUE so existing tenants behave identically to
-- before this migration (current behavior fires every notification when
-- creds are configured + plan allows). A tenant who wants to suppress
-- specific events flips the toggle they want off.
--
-- Toggle resolution at send-time (utils/notificationGates.js):
--
--   should_send = plan_has_feature
--               AND tenant_has_credentials
--               AND tenant_event_toggle_enabled
--
-- Each event-window pair has its own column so a tenant can:
--   - keep confirmations on, turn off all reminders
--   - send 1h reminders only (turn off 24h)
--   - turn off SMS entirely while keeping WhatsApp on
--   - flip cancellations off (some businesses don't want a "your booking
--     was cancelled" SMS racing the customer's own portal action)
--
-- Channel separation: SMS toggles and WA toggles are independent. A tenant
-- using both channels can configure each independently — the existing
-- belt-and-suspenders behavior continues unless explicitly disabled.
--
-- All statements idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── SMS toggles ─────────────────────────────────────────────────────────────

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS sms_confirmations_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sms_reminder_24h_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sms_reminder_1h_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sms_cancellations_enabled  BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN tenants.sms_confirmations_enabled  IS
  'Per-tenant toggle for booking-confirmation SMS. Composed with plan feature + Twilio credential check at send time.';
COMMENT ON COLUMN tenants.sms_reminder_24h_enabled   IS
  '24-hour reminder SMS toggle. Default TRUE — flip to FALSE to suppress 24h reminders independently of 1h.';
COMMENT ON COLUMN tenants.sms_reminder_1h_enabled    IS
  '1-hour reminder SMS toggle. Default TRUE — paired with sms_reminder_24h_enabled to express "1h only" or "24h only" preferences.';
COMMENT ON COLUMN tenants.sms_cancellations_enabled  IS
  'Cancellation-notice SMS toggle. Default TRUE — some businesses prefer not to send these because they race with the customer''s own portal action.';

-- ── WhatsApp toggles ───────────────────────────────────────────────────────

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS wa_confirmations_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS wa_reminder_24h_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS wa_reminder_1h_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS wa_cancellations_enabled  BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN tenants.wa_confirmations_enabled  IS
  'Per-tenant toggle for booking-confirmation WhatsApp. Independent of sms_confirmations_enabled.';
COMMENT ON COLUMN tenants.wa_reminder_24h_enabled   IS
  '24-hour reminder WhatsApp toggle.';
COMMENT ON COLUMN tenants.wa_reminder_1h_enabled    IS
  '1-hour reminder WhatsApp toggle.';
COMMENT ON COLUMN tenants.wa_cancellations_enabled  IS
  'Cancellation-notice WhatsApp toggle.';

COMMIT;

-- ── Verification ───────────────────────────────────────────────────────────
-- After running:
--   SELECT id, slug, sms_confirmations_enabled, sms_reminder_24h_enabled,
--          sms_reminder_1h_enabled, sms_cancellations_enabled,
--          wa_confirmations_enabled, wa_reminder_24h_enabled,
--          wa_reminder_1h_enabled, wa_cancellations_enabled
--   FROM tenants
--   ORDER BY id
--   LIMIT 5;
-- Expected: every tenant has all 8 toggles = TRUE.
