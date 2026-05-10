-- Migration 070: THEMES-V2 Phase 5.2 — platform_shells + platform_layouts + tenants columns
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- Phase 5.2 introduces the shell and layout primitives.
--
-- SHELL = the outer chrome (header, footer, nav, page frame).
--   Catalog seed: classic, premium, minimal, modern.
--
-- LAYOUT = section ordering + instance config inside the shell. Layouts
--   reference section types from a supported catalog stored on the row.
--   Catalog seed: legacy_default (the current public booking-page composition).
--   boutique-editorial intentionally NOT seeded — Phase 3.4 follow-up.
--
-- Two columns are added to tenants:
--   shell_key      — TEXT, nullable. NULL = derive from theme_key at read time.
--   layout_key_v2  — TEXT, nullable. NULL = use legacy_default at read time.
--
-- Both columns remain NULL for every tenant in production (including the
-- three protected: 3 birdie-golf, 21 alrazi, 33 aqababooking). No tenant
-- rows are flipped. No frontend consumer code exists yet — this is
-- schema + seeds + an additive READ endpoint extension only.
--
-- ─── ZERO BEHAVIOR CHANGE ────────────────────────────────────────────────────
--
-- * No tenant.theme_key flipped.
-- * No tenant.shell_key or layout_key_v2 populated.
-- * publicTenantTheme.js returns NEW shell/layout blocks but does not
--   change any pre-existing response field.
-- * Frontend ignores the new blocks until Phase 5.3+ ships a consumer.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--
-- BEGIN;
-- ALTER TABLE tenants DROP COLUMN IF EXISTS layout_key_v2;
-- ALTER TABLE tenants DROP COLUMN IF EXISTS shell_key;
-- DROP TABLE IF EXISTS platform_layouts;
-- DROP TABLE IF EXISTS platform_shells;
-- COMMIT;

BEGIN;

-- ─── platform_shells ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_shells (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_shells IS
  'Outer-chrome shell catalog. Tenants reference rows via tenants.shell_key; NULL means derive from theme_key at read time (see routes/publicTenantTheme.js).';

INSERT INTO platform_shells (key, name) VALUES
  ('classic', 'Classic'),
  ('premium', 'Premium'),
  ('minimal', 'Minimal'),
  ('modern',  'Modern')
ON CONFLICT (key) DO NOTHING;

-- ─── platform_layouts ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_layouts (
  key                          TEXT PRIMARY KEY,
  name                         TEXT NOT NULL,
  version                      INTEGER NOT NULL DEFAULT 1,
  is_published                 BOOLEAN NOT NULL DEFAULT TRUE,
  sections_json                JSONB NOT NULL,
  supported_section_types_json JSONB NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_layouts IS
  'Section-ordering catalog. sections_json is the ordered list of section instances; supported_section_types_json is the catalog of section types this layout knows about. Tenants reference rows via tenants.layout_key_v2; NULL means use legacy_default at read time.';

-- Seed: legacy_default
INSERT INTO platform_layouts (key, name, sections_json, supported_section_types_json) VALUES
  (
    'legacy_default',
    'Legacy Default',
    '[
      { "id": "nav",      "type": "nav_header",       "enabled": true },
      { "id": "hero",     "type": "hero",             "enabled": true },
      { "id": "services", "type": "service_selector", "enabled": true },
      { "id": "date",     "type": "date_picker",      "enabled": true },
      { "id": "time",     "type": "time_slots",       "enabled": true },
      { "id": "form",     "type": "customer_form",    "enabled": true },
      { "id": "footer",   "type": "footer",           "enabled": true }
    ]'::jsonb,
    '[
      "nav_header",
      "hero",
      "service_selector",
      "service_grid",
      "date_picker",
      "time_slots",
      "customer_form",
      "footer"
    ]'::jsonb
  )
ON CONFLICT (key) DO NOTHING;

-- ─── tenants columns ─────────────────────────────────────────────────────────

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS shell_key     TEXT NULL,
  ADD COLUMN IF NOT EXISTS layout_key_v2 TEXT NULL;

COMMENT ON COLUMN tenants.shell_key IS
  'Optional override of the platform_shells catalog. NULL = derive from theme_key at read time (see routes/publicTenantTheme.js).';

COMMENT ON COLUMN tenants.layout_key_v2 IS
  'Optional override of the platform_layouts catalog. NULL = use legacy_default at read time.';

COMMIT;
