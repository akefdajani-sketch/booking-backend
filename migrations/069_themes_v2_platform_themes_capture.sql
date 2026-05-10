-- Migration 069: THEMES-V2 Phase 5.1.5 — platform_themes schema capture + orphan cleanup
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- The platform_themes table was provisioned out-of-band on production and
-- seeded by migration 013_seed_premium_v2.sql, which referenced it as if
-- it already existed. A fresh environment can't be reconstructed from the
-- migrations directory alone today — this migration fixes that by
-- capturing the live schema as CREATE TABLE IF NOT EXISTS.
--
-- Live column shape (per routes/adminThemes.js + scripts/themes_v2/01_audit
-- inventory):
--   key          TEXT PRIMARY KEY
--   name         TEXT NOT NULL
--   version      INTEGER NOT NULL DEFAULT 1
--   is_published BOOLEAN NOT NULL DEFAULT FALSE
--   layout_key   TEXT
--   tokens_json  JSONB NOT NULL DEFAULT '{}'::jsonb
--   created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
--   updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
--
-- Notes:
--   * Migration 013 referenced an `is_active` column that does NOT exist
--     on the live table. The audit cross-confirmed: only is_published is
--     used in production. This migration intentionally omits is_active.
--   * On a fresh DB the table is created with this exact shape; on an
--     existing DB the CREATE TABLE IF NOT EXISTS is a no-op.
--
-- ─── ORPHAN CLEANUP ──────────────────────────────────────────────────────────
--
-- Phase 5.1's audit surfaced 'premuim_light_v2' (sic — typo of
-- premium_light_v2). Zero tenants reference it and it fails the migration
-- 067 CHECK constraint on tenants.theme_key. DELETE it here per Phase 5.1.5.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--
-- The CREATE TABLE IF NOT EXISTS is a no-op on rollback (table already
-- existed in production). The orphan DELETE is irreversible without a
-- backup — restoring the original tokens_json is not the goal of rollback.

BEGIN;

CREATE TABLE IF NOT EXISTS platform_themes (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  layout_key   TEXT,
  tokens_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_themes IS
  'Platform-managed theme catalog. Tenants reference rows via tenants.theme_key. Captured as a schema-creation migration in Phase 5.1.5; previously provisioned out-of-band.';

-- Phase 5.1.5 orphan cleanup
DELETE FROM platform_themes WHERE key = 'premuim_light_v2';

COMMIT;
