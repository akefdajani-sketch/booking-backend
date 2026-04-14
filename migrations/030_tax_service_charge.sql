-- migrations/030_tax_service_charge.sql
-- PR-TAX-1: VAT / Service Charge / POS Tax Engine
--
-- Adds tax infrastructure across three layers:
--   1. services     – per-service VAT override (nullable → falls back to tenant default)
--   2. bookings     – tax snapshot columns so historical records are immutable
--   3. tenants      – tax_config JSONB for business-wide defaults
--
-- Fully idempotent. Safe to run against production.

-- ─── 1. Per-service tax overrides ─────────────────────────────────────────────
-- vat_rate:            e.g. 16 (percent). NULL means "use tenant default".
-- vat_label:           e.g. "VAT", "GST", "TVA", "Sales Tax". NULL → use tenant label.
-- service_charge_rate: e.g. 5 (percent). NULL → use tenant default.
ALTER TABLE services ADD COLUMN IF NOT EXISTS vat_rate             NUMERIC(6,3);
ALTER TABLE services ADD COLUMN IF NOT EXISTS vat_label            TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS service_charge_rate  NUMERIC(6,3);

-- ─── 2. Booking tax snapshot columns ──────────────────────────────────────────
-- subtotal_amount:          base price BEFORE any tax (even if prices are tax-inclusive)
-- vat_amount:               VAT charged on this booking
-- service_charge_amount:    service charge applied
-- total_amount:             grand total = subtotal + vat + service_charge
-- tax_snapshot:             JSONB — the full tax config used at booking time
--                           so rate changes never corrupt historical records
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS subtotal_amount         NUMERIC(12,3);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vat_amount              NUMERIC(12,3);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_charge_amount   NUMERIC(12,3);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_amount            NUMERIC(12,3);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tax_snapshot            JSONB;

-- ─── 3. Tenant-level tax config ───────────────────────────────────────────────
-- Stored as JSONB for flexibility. Shape:
-- {
--   "vat_rate":                16,
--   "vat_label":               "VAT",
--   "service_charge_rate":     5,
--   "service_charge_label":    "Service Charge",
--   "tax_inclusive":           false,
--   "show_tax_breakdown":      true,
--   "tax_registration_number": "JO123456789"
-- }
--
-- tax_inclusive = false → price is EXCLUSIVE: displayed price + tax = total
-- tax_inclusive = true  → price is INCLUSIVE: tax is extracted from price for display
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tax_config JSONB;

-- ─── 4. Index for analytics queries on tax amounts ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_tax
  ON bookings (tenant_id)
  WHERE vat_amount IS NOT NULL OR service_charge_amount IS NOT NULL;

-- ─── 5. Helpful comment for future engineers ──────────────────────────────────
COMMENT ON COLUMN services.vat_rate IS
  'Per-service VAT % override. NULL = use tenants.tax_config->vat_rate.';
COMMENT ON COLUMN services.service_charge_rate IS
  'Per-service service charge % override. NULL = use tenants.tax_config->service_charge_rate.';
COMMENT ON COLUMN bookings.tax_snapshot IS
  'Immutable snapshot of the tax config applied at booking creation time. Never update retroactively.';
COMMENT ON COLUMN tenants.tax_config IS
  'Business-wide tax configuration. See migration 030 for full JSONB shape.';
