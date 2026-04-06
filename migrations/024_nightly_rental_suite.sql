-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 024: Nightly Rental Suite
--
-- Adds the full operational layer for Airbnb-style property rentals:
--
--   1. resource_amenities    — free amenities list per resource (WiFi, Pool…)
--   2. resource_addons       — paid optional add-ons per resource (breakfast, transfer…)
--   3. resources.property_details_json — bedrooms, bathrooms, area, max_guests etc.
--   4. bookings.addons_json  — selected add-ons stored per booking
--   5. bookings.guests_count — number of guests stored per booking
--
-- All statements are idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. Property details on resources ────────────────────────────────────────
-- Stored as JSONB for flexibility. Schema:
-- {
--   "bedrooms": 2, "bathrooms": 1, "area_sqm": 85,
--   "max_guests": 4, "floor": 3,
--   "description": "Cozy apartment with sea view...",
--   "house_rules": "No smoking, no pets.",
--   "cancellation_policy": "Free cancellation up to 48h before check-in."
-- }
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS property_details_json JSONB;

-- ─── 2. resource_amenities ────────────────────────────────────────────────────
-- Free amenities shown on the booking page (no extra charge).
-- Examples: WiFi, Pool, Parking, Air Conditioning, Kitchen, Washer…
CREATE TABLE IF NOT EXISTS resource_amenities (
  id            BIGSERIAL   PRIMARY KEY,
  tenant_id     BIGINT      NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  resource_id   BIGINT      NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  label         TEXT        NOT NULL,           -- "WiFi", "Pool", "Parking"
  icon          TEXT,                           -- emoji or icon key "📶" "🏊" "🅿️"
  category      TEXT,                           -- "essentials" | "outdoors" | "facilities"
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resource_amenities_resource
  ON resource_amenities (resource_id, sort_order)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_resource_amenities_tenant
  ON resource_amenities (tenant_id);

-- ─── 3. resource_addons ───────────────────────────────────────────────────────
-- Paid optional add-ons the guest can select during booking.
-- Examples: Breakfast, Late check-out, Early check-in, Airport transfer…
--
-- price_type:
--   'per_night' → addon.price × nights_count
--   'flat'      → addon.price (one-time charge regardless of nights)
--   'per_guest' → addon.price × guests_count
CREATE TABLE IF NOT EXISTS resource_addons (
  id            BIGSERIAL   PRIMARY KEY,
  tenant_id     BIGINT      NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  resource_id   BIGINT      NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  label         TEXT        NOT NULL,           -- "Breakfast included"
  icon          TEXT,                           -- "🍳"
  description   TEXT,                           -- "Daily continental breakfast for all guests"
  price         NUMERIC(12,3) NOT NULL DEFAULT 0,
  price_type    TEXT        NOT NULL DEFAULT 'flat'
                  CONSTRAINT resource_addons_price_type_check
                  CHECK (price_type IN ('per_night', 'flat', 'per_guest')),
  currency_code TEXT,                           -- NULL = inherit from tenant
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resource_addons_resource
  ON resource_addons (resource_id, sort_order)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_resource_addons_tenant
  ON resource_addons (tenant_id);

-- updated_at trigger for resource_addons
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_resource_addons_updated_at'
  ) THEN
    CREATE TRIGGER trg_resource_addons_updated_at
      BEFORE UPDATE ON resource_addons
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END$$;

-- ─── 4. bookings — add-ons + guest count ─────────────────────────────────────
-- Store selected add-ons as JSONB so the confirmation/invoice shows
-- exactly what was charged.
--
-- addons_json schema:
-- [
--   { "addon_id": 5, "label": "Breakfast", "icon": "🍳",
--     "price": 15, "price_type": "per_night", "qty": 1,
--     "subtotal": 30 }
-- ]
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS addons_json    JSONB,
  ADD COLUMN IF NOT EXISTS guests_count   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS addons_total   NUMERIC(12,3) NOT NULL DEFAULT 0;

COMMIT;
