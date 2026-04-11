-- migrations/029_tenant_whatsapp_credentials.sql
-- WA-1: Per-tenant WhatsApp Business Cloud API credentials
--
-- Each tenant can store their own Meta WhatsApp Business account credentials.
-- This removes the dependency on global env vars and follows the same pattern
-- as payment credentials (migration 018).
--
-- Security model:
--   whatsapp_access_token    — stored AES-256-GCM encrypted (same TENANT_CREDS_KEY)
--   whatsapp_phone_number_id — stored plain (not secret, used in API URLs)
--   whatsapp_active          — boolean, true once configured
--
-- Fallback:
--   utils/whatsappCredentials.js falls back to WHATSAPP_ACCESS_TOKEN /
--   WHATSAPP_PHONE_NUMBER_ID env vars if no DB record exists.
--   Existing tenants keep working with zero disruption.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS whatsapp_access_token     TEXT;  -- AES-256-GCM encrypted
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS whatsapp_active           BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.whatsapp_phone_number_id IS 'Meta WhatsApp Phone Number ID from API Setup page';
COMMENT ON COLUMN tenants.whatsapp_access_token    IS 'AES-256-GCM encrypted permanent System User token. Key = TENANT_CREDS_KEY env var.';
COMMENT ON COLUMN tenants.whatsapp_active          IS 'True once tenant has saved WhatsApp credentials.';
