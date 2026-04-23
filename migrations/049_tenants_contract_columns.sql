-- migrations/049_tenants_contract_columns.sql
-- G2a-1: Add per-tenant config columns needed by the contracts workflow.
--
-- contract_number_prefix
--   Used by utils/contracts.js to generate contract numbers in the form
--   "{PREFIX}-CON-{YYYY}-{SEQ:04d}", e.g. "AQB-CON-2026-0001".
--   Nullable: if NULL, code falls back to UPPER(LEFT(slug, 3)).
--   Required length 2-10 when set.
--
-- stripe_tax_rate_id
--   Stores the Stripe Tax Rate object ID (e.g. txr_1Nxxxxxxxx).
--   Created once per tenant via Stripe API, attached to every contract
--   invoice. Separate from tenants.tax_config (which is our internal VAT
--   config) because Stripe Tax Rates are immutable once attached to an
--   invoice — if tax rate changes, a new Stripe object is created and
--   this column swapped. Existing invoices retain the old tax rate ID.
--
-- Fully idempotent.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS contract_number_prefix TEXT,
  ADD COLUMN IF NOT EXISTS stripe_tax_rate_id     TEXT;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS chk_tenants_contract_prefix_length;
ALTER TABLE tenants
  ADD CONSTRAINT chk_tenants_contract_prefix_length
  CHECK (contract_number_prefix IS NULL
         OR (length(contract_number_prefix) BETWEEN 2 AND 10));

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS chk_tenants_contract_prefix_format;
ALTER TABLE tenants
  ADD CONSTRAINT chk_tenants_contract_prefix_format
  CHECK (contract_number_prefix IS NULL
         OR contract_number_prefix ~ '^[A-Z0-9]+$');

COMMENT ON COLUMN tenants.contract_number_prefix IS
  'G2a: Per-tenant prefix for contract numbers ({PREFIX}-CON-{YYYY}-{SEQ}). NULL → code falls back to UPPER(LEFT(slug,3)).';
COMMENT ON COLUMN tenants.stripe_tax_rate_id IS
  'G2a: Stripe Tax Rate object ID (e.g. txr_xxx), attached to contract invoices. Driven by tax_config.vat_rate + tax_config.tax_inclusive.';
