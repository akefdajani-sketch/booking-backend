-- Migration 067: THEMES-V2 Phase 2.1 — tenant theme_key constraint
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- Surfaces tenants.theme_key as a constrained, non-nullable column with a
-- safe default. Today the column already exists (added implicitly via
-- migration 011_add_tenant_appearance_snapshot which created the
-- idx_tenants_theme_key index), but it allows arbitrary values including
-- NULL and empty strings. This migration:
--
--   1. Backfills empty/NULL/legacy-loose values to canonical defaults
--   2. Sets DEFAULT 'classic' for future inserts
--   3. Sets NOT NULL
--   4. Adds CHECK constraint with the explicit allow-list of valid theme keys
--
-- The allow-list intentionally includes legacy variants (premium_v1, premium_v2,
-- premium_light) that production tenants are still using. Runtime
-- normalizeThemeKey() in lib/theme/isThemeFamily.ts and theme/contractThemeRegistry.js
-- already maps these to canonical keys (premium_v\d+ → premium, etc.). This
-- migration just stops the DB from accepting unknown values on write — it
-- doesn't force a normalization sweep. Legacy normalization is a separate
-- migration to be scheduled after Phase 4 (when the v2 themes are live and
-- tenants can be migrated forward instead of back).
--
-- ─── PRODUCTION TENANT DISTRIBUTION (audit 2026-05-10) ───────────────────────
--
--   theme_key         count   action in this migration
--   ─────────────     ─────   ────────────────────────
--   '' (empty)            7   → backfilled to 'classic'
--   'premium_v1'          7   kept (legacy allow-list)
--   'premium'             7   kept (canonical)
--   'premium_v2'          2   kept (legacy allow-list)
--   'classic'             1   kept (canonical)
--   'premium_light'       1   kept (legacy allow-list)
--   ─────────────     ─────
--                        25
--
-- Defensive backfill also handles 'default', 'default_v1', and any other
-- non-canonical values that runtime normalizeThemeKey would map to 'classic'.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--
-- BEGIN;
-- ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_theme_key_check;
-- ALTER TABLE tenants ALTER COLUMN theme_key DROP NOT NULL;
-- ALTER TABLE tenants ALTER COLUMN theme_key DROP DEFAULT;
-- COMMIT;
--
-- (Index idx_tenants_theme_key is preserved — it predates this migration.)

BEGIN;

-- ─── Step 1: Backfill empty/null values to safe default ──────────────────────

UPDATE tenants
SET theme_key = 'classic'
WHERE theme_key IS NULL
   OR TRIM(theme_key) = ''
   OR theme_key IN ('default', 'default_v1');

-- ─── Step 2: Set default + NOT NULL ──────────────────────────────────────────

ALTER TABLE tenants
  ALTER COLUMN theme_key SET DEFAULT 'classic';

ALTER TABLE tenants
  ALTER COLUMN theme_key SET NOT NULL;

-- ─── Step 3: CHECK constraint with explicit allow-list ───────────────────────

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_theme_key_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_theme_key_check
  CHECK (theme_key IN (
    -- Phase 1 canonical themes (live in registry)
    'classic', 'premium', 'minimal',
    -- Legacy themes (still in production data; runtime normalizes to canonical)
    'premium_v1', 'premium_v2', 'premium_light',
    -- Phase 2/3/4 new themes (per THEMES-V2 master plan)
    'premium-hospitality', 'calm-clinical', 'marketplace-listings',
    'boutique-beauty', 'artisan-kitchen', 'modern-minimal'
  ));

COMMENT ON COLUMN tenants.theme_key IS
  'Active theme key for the tenant''s public booking page. Constrained to the THEMES-V2 allow-list. Legacy values (premium_v1/v2, premium_light) remain valid until Phase 4 retirement; runtime normalizeThemeKey() handles normalization.';

COMMIT;
