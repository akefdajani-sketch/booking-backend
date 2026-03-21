-- 014_service_categories.sql
-- PR-CAT1: Service Categories
--
-- Adds a service_categories table so tenants can group services and expose
-- a category filter on the public booking tab.
-- Mirrors the resources/staff pattern exactly.
-- Fully idempotent — safe to re-run against an existing database.

-- ─── service_categories ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_categories (
  id             SERIAL PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  image_url      TEXT,
  color          TEXT,              -- optional hex colour for UI chips, e.g. "#4f46e5"
  display_order  INTEGER NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_categories_tenant
  ON service_categories (tenant_id);

CREATE INDEX IF NOT EXISTS idx_service_categories_tenant_active
  ON service_categories (tenant_id, is_active)
  WHERE is_active = true;

-- Prevent duplicate names per tenant (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_categories_tenant_name
  ON service_categories (tenant_id, lower(name));

COMMENT ON TABLE service_categories IS
  'Tenant-scoped service groups. Used to filter the public booking tab.';
COMMENT ON COLUMN service_categories.color IS
  'Optional accent colour for the category pill, e.g. #4f46e5. NULL = theme default.';
COMMENT ON COLUMN service_categories.display_order IS
  'Ascending sort order for category filter pills. Lower = shown first.';

-- ─── Link services to categories ─────────────────────────────────────────────
-- One category per service (nullable — NULL = uncategorised, always visible under "All").
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS category_id INTEGER
    REFERENCES service_categories(id)
    ON DELETE SET NULL;   -- deleting a category uncategorises its services, never cascades bookings

CREATE INDEX IF NOT EXISTS idx_services_category
  ON services (tenant_id, category_id)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN services.category_id IS
  'Optional category grouping. NULL = uncategorised (always shown under "All" filter).';
