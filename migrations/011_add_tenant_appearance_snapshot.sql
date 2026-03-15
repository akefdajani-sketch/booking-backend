ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS appearance_snapshot_published_json jsonb,
  ADD COLUMN IF NOT EXISTS appearance_snapshot_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS appearance_snapshot_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS appearance_snapshot_source_theme_key text,
  ADD COLUMN IF NOT EXISTS appearance_snapshot_layout_key text;

CREATE INDEX IF NOT EXISTS idx_tenants_theme_key
  ON tenants(theme_key);
