-- migrations/036_tenant_twilio_credentials.sql
-- PR 145: Per-tenant Twilio Programmable Messaging credentials
--
-- Mirrors migration 029 (tenant WhatsApp credentials) — same encryption
-- key (TENANT_CREDS_KEY), same storage pattern, same fallback behavior via
-- utils/twilioCredentials.js.
--
-- Security model:
--   twilio_account_sid            — stored plain (starts with 'AC', 34 chars, not secret on its own)
--   twilio_auth_token             — stored AES-256-GCM encrypted (TENANT_CREDS_KEY)
--   twilio_from_number            — stored plain (E.164, not secret)
--   twilio_messaging_service_sid  — stored plain, optional (starts with 'MG', 34 chars)
--   twilio_active                 — boolean, true once configured
--
-- Fallback:
--   utils/twilioCredentials.js falls back to TWILIO_ACCOUNT_SID /
--   TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / TWILIO_MESSAGING_SERVICE_SID env
--   vars if no DB record exists. Existing tenants using platform defaults
--   keep working with zero disruption.
--
-- Fully idempotent. Safe to run against production multiple times.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS twilio_account_sid            TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS twilio_auth_token             TEXT;  -- AES-256-GCM encrypted
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS twilio_from_number            TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS twilio_messaging_service_sid  TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS twilio_active                 BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.twilio_account_sid            IS 'Twilio Account SID (AC…). Stored plain — not secret on its own.';
COMMENT ON COLUMN tenants.twilio_auth_token             IS 'AES-256-GCM encrypted Twilio Auth Token. Key = TENANT_CREDS_KEY env var.';
COMMENT ON COLUMN tenants.twilio_from_number            IS 'E.164 from number used for outbound SMS.';
COMMENT ON COLUMN tenants.twilio_messaging_service_sid  IS 'Optional Twilio Messaging Service SID (MG…). Used instead of from number when set.';
COMMENT ON COLUMN tenants.twilio_active                 IS 'True once tenant has saved Twilio credentials.';
