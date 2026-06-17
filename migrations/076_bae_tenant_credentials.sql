-- 076: Bank al Etihad (Cybersource) per-tenant credentials. Mirrors migration 018 (MPGS).
-- Secret + capture-context token AES-256-GCM encrypted via TENANT_CREDS_KEY (same helper
-- as network_api_password). Merchant ID + host stored plain. payment_provider selects gateway.
-- NO BEGIN/COMMIT — the migrate runner wraps each file in its own transaction. Idempotent.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bank_etihad_merchant_id TEXT;   -- plain (Cybersource MID)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bank_etihad_api_secret  TEXT;   -- AES-256-GCM encrypted
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bank_etihad_cc_token    TEXT;   -- AES-256-GCM encrypted (capture-context auth token)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bank_etihad_host        TEXT;   -- plain (prod default api.cybersource.com)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS payment_provider        TEXT;   -- 'network' | 'bank_etihad' | NULL

COMMENT ON COLUMN tenants.bank_etihad_merchant_id IS 'Cybersource merchant ID (BAE white-label).';
COMMENT ON COLUMN tenants.bank_etihad_api_secret  IS 'AES-256-GCM encrypted. Key = TENANT_CREDS_KEY.';
COMMENT ON COLUMN tenants.bank_etihad_cc_token    IS 'AES-256-GCM encrypted capture-context auth token.';
COMMENT ON COLUMN tenants.bank_etihad_host        IS 'Cybersource host. Defaults to api.cybersource.com.';
COMMENT ON COLUMN tenants.payment_provider        IS 'Which gateway the tenant uses: network | bank_etihad | NULL.';
