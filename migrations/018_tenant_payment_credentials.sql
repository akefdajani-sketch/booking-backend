-- migrations/018_tenant_payment_credentials.sql
-- PAY-1: Per-tenant payment gateway credentials
--
-- Each tenant on Flexrz has their own Network International merchant account.
-- Money flows directly from customers into each tenant's bank — Flexrz never
-- holds or processes funds.
--
-- Security model:
--   network_merchant_id  — stored plain (not secret, appears in API URLs)
--   network_api_password — stored AES-256-GCM encrypted using TENANT_CREDS_KEY
--   network_gateway_url  — stored plain (test vs production URL)
--
-- Fallback:
--   If a tenant has no DB credentials, utils/networkCredentials.js falls back
--   to NETWORK_MERCHANT_ID / NETWORK_API_PASSWORD env vars.
--   This covers Birdie Golf during initial setup while the UI is being built.
--
-- All statements are idempotent.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS network_merchant_id    TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS network_api_password   TEXT;  -- AES-256-GCM encrypted
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS network_gateway_url    TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS payment_gateway_active BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.network_merchant_id    IS 'Network International merchant ID (no "merchant." prefix)';
COMMENT ON COLUMN tenants.network_api_password   IS 'AES-256-GCM encrypted API password. Key = TENANT_CREDS_KEY env var.';
COMMENT ON COLUMN tenants.network_gateway_url    IS 'MPGS gateway base URL. Defaults to test env if null.';
COMMENT ON COLUMN tenants.payment_gateway_active IS 'True once tenant has connected and verified their payment account.';
