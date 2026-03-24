BEGIN;

CREATE TABLE IF NOT EXISTS media_assets (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'logo')),
  usage_type TEXT NOT NULL DEFAULT 'general',
  title TEXT,
  alt_text TEXT,
  caption TEXT,
  storage_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT,
  width INTEGER,
  height INTEGER,
  duration_seconds NUMERIC(10,2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_tenant_usage_created
  ON media_assets (tenant_id, usage_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_assets_tenant_kind_created
  ON media_assets (tenant_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_assets_tenant_active_created
  ON media_assets (tenant_id, is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS media_asset_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  media_asset_id BIGINT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'tenant',
      'home_landing',
      'service',
      'staff',
      'resource',
      'membership_plan',
      'prepaid_product'
    )
  ),
  entity_id BIGINT NULL,
  slot TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_asset_links_slot
  ON media_asset_links (tenant_id, entity_type, COALESCE(entity_id, 0), slot);

CREATE INDEX IF NOT EXISTS idx_media_asset_links_media_asset_id
  ON media_asset_links (media_asset_id);

CREATE INDEX IF NOT EXISTS idx_media_asset_links_entity
  ON media_asset_links (tenant_id, entity_type, COALESCE(entity_id, 0));

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS logo_light_url TEXT,
  ADD COLUMN IF NOT EXISTS logo_light_key TEXT,
  ADD COLUMN IF NOT EXISTS logo_dark_url TEXT,
  ADD COLUMN IF NOT EXISTS logo_dark_key TEXT,
  ADD COLUMN IF NOT EXISTS memberships_image_url TEXT,
  ADD COLUMN IF NOT EXISTS memberships_image_key TEXT,
  ADD COLUMN IF NOT EXISTS packages_image_url TEXT,
  ADD COLUMN IF NOT EXISTS packages_image_key TEXT,
  ADD COLUMN IF NOT EXISTS banner_packages_url TEXT,
  ADD COLUMN IF NOT EXISTS banner_packages_key TEXT;

ALTER TABLE membership_plans
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS image_key TEXT;

ALTER TABLE prepaid_products
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS image_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at'
  ) THEN
    CREATE FUNCTION set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $fn$;
  END IF;
END$$;

DROP TRIGGER IF EXISTS trg_media_assets_updated_at ON media_assets;
CREATE TRIGGER trg_media_assets_updated_at
BEFORE UPDATE ON media_assets
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_media_asset_links_updated_at ON media_asset_links;
CREATE TRIGGER trg_media_asset_links_updated_at
BEFORE UPDATE ON media_asset_links
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
