ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS appearance_snapshot_published_json JSONB,
  ADD COLUMN IF NOT EXISTS appearance_snapshot_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS appearance_snapshot_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS appearance_snapshot_source_theme_key TEXT,
  ADD COLUMN IF NOT EXISTS appearance_snapshot_layout_key TEXT;

CREATE INDEX IF NOT EXISTS idx_tenants_theme_key ON tenants(theme_key);
