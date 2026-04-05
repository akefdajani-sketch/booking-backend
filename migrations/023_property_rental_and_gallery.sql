-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 023: Property Rental Mode + Resource Gallery
--
-- Adds multi-night / date-range "property rental" capability as a per-service
-- toggle.  A service can be either:
--   booking_mode = 'time_slots'  → current behaviour (default, no change)
--   booking_mode = 'nightly'     → check-in / check-out date selection,
--                                   price computed as nights × price_per_night
--
-- Also introduces resource_gallery for ordered multi-image support.
-- The existing resources.image_url column is preserved as the "cover" image.
--
-- All statements are idempotent — safe to re-run against an existing DB.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. services — rental fields ─────────────────────────────────────────────

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS booking_mode      TEXT    NOT NULL DEFAULT 'time_slots'
    CONSTRAINT services_booking_mode_check
      CHECK (booking_mode IN ('time_slots', 'nightly')),

  -- nightly: minimum number of nights a guest must book
  ADD COLUMN IF NOT EXISTS min_nights        INTEGER NOT NULL DEFAULT 1,

  -- nightly: maximum nights allowed per booking (NULL = unlimited)
  ADD COLUMN IF NOT EXISTS max_nights        INTEGER,

  -- nightly: the standard check-in / check-out times (stored as HH:MM)
  ADD COLUMN IF NOT EXISTS checkin_time      TIME    NOT NULL DEFAULT '15:00',
  ADD COLUMN IF NOT EXISTS checkout_time     TIME    NOT NULL DEFAULT '11:00',

  -- nightly: price per night (separate from per-session price_amount / price)
  -- If NULL, falls back to services.price / price_amount for backward compat
  ADD COLUMN IF NOT EXISTS price_per_night   NUMERIC(12,3);

-- ─── 2. resource_gallery ─────────────────────────────────────────────────────
-- Ordered gallery images for a resource / property.
-- The primary "cover" image stays in resources.image_url for backward compat.
-- Additional gallery images live here with sort_order 0 = first / featured.

CREATE TABLE IF NOT EXISTS resource_gallery (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT    NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  resource_id     BIGINT    NOT NULL REFERENCES resources(id) ON DELETE CASCADE,

  -- R2 storage key (used for deletion / CDN busting)
  storage_key     TEXT      NOT NULL,

  -- Public CDN URL for display
  public_url      TEXT      NOT NULL,

  -- Display metadata
  alt_text        TEXT,
  caption         TEXT,

  -- MIME type & dimensions (from upload)
  mime_type       TEXT,
  width           INTEGER,
  height          INTEGER,
  file_size       BIGINT,

  -- 0-based display order; lower = first shown
  sort_order      INTEGER   NOT NULL DEFAULT 0,

  is_active       BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resource_gallery_resource
  ON resource_gallery (resource_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_resource_gallery_tenant
  ON resource_gallery (tenant_id, created_at DESC);

-- ─── 3. updated_at trigger for resource_gallery ───────────────────────────────

DO $$
BEGIN
  -- set_updated_at function is created by migration 015 — reuse it.
  -- Create trigger only if it doesn't already exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_resource_gallery_updated_at'
  ) THEN
    CREATE TRIGGER trg_resource_gallery_updated_at
      BEFORE UPDATE ON resource_gallery
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  END IF;
END$$;

-- ─── 4. Bookings — nightly metadata ──────────────────────────────────────────
-- For nightly bookings we store check-in / check-out as plain dates alongside
-- the existing TIMESTAMPTZ columns (start_time / end_time) which are set to
-- midnight UTC on those dates.  These are convenience columns for queries.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_mode   TEXT   DEFAULT 'time_slots'
    CONSTRAINT bookings_booking_mode_check
      CHECK (booking_mode IN ('time_slots', 'nightly')),

  ADD COLUMN IF NOT EXISTS checkin_date   DATE,
  ADD COLUMN IF NOT EXISTS checkout_date  DATE,
  ADD COLUMN IF NOT EXISTS nights_count   INTEGER;

CREATE INDEX IF NOT EXISTS idx_bookings_nightly_resource
  ON bookings (resource_id, checkin_date, checkout_date)
  WHERE booking_mode = 'nightly' AND deleted_at IS NULL;

-- ─── 5. tenant_settings — rental mode toggle ─────────────────────────────────
-- Tenants can enable "rental mode" at the tenant level to unlock nightly
-- services in the setup UI.  Individual services still control booking_mode.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS rental_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
