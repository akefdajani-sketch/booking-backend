-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 030: Payment Link Reminder Log
--
-- Tracks every WhatsApp reminder sent for a rental_payment_links row.
-- The reminder engine checks this table to avoid duplicate sends.
--
-- Reminder types:
--   initial      — sent at link creation (already handled in rentalPaymentLinks.js)
--   followup_2d  — sent 2 days after creation if still pending
--   followup_5d  — sent 5 days after creation if still pending
--   expiry_2d    — sent 2 days before expiry if still pending
--   expiry_1d    — sent 1 day before expiry if still pending
--   expiry_day   — sent on the day of expiry if still pending
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS payment_link_reminders (
  id              BIGSERIAL     PRIMARY KEY,
  link_id         BIGINT        NOT NULL REFERENCES rental_payment_links(id) ON DELETE CASCADE,
  tenant_id       BIGINT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reminder_type   TEXT          NOT NULL
                    CONSTRAINT plr_type_check
                    CHECK (reminder_type IN (
                      'initial','followup_2d','followup_5d',
                      'expiry_2d','expiry_1d','expiry_day'
                    )),
  sent_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  sent_to         TEXT,           -- phone number
  whatsapp_msg_id TEXT,           -- Meta message ID for delivery tracking
  ok              BOOLEAN       NOT NULL DEFAULT true,
  error_reason    TEXT,           -- if ok=false, why it failed

  UNIQUE (link_id, reminder_type)   -- one of each type per link
);

CREATE INDEX IF NOT EXISTS idx_plr_link_id   ON payment_link_reminders (link_id);
CREATE INDEX IF NOT EXISTS idx_plr_tenant_id ON payment_link_reminders (tenant_id, sent_at DESC);

COMMIT;
