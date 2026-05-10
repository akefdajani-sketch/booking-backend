-- scripts/themes_v2/04_rollback.sql
-- ─────────────────────────────────────────────────────────────────────────
-- THEMES-V2 Phase 5.1 — emergency rollback.
--
-- Removes the platform_themes rows inserted by 02_apply_theme_sync.js.
-- After rollback, the resolver's LEFT JOIN returns NULL for these keys,
-- falling back to the 3.2-RETRY-2 code-default path. Since both keys had
-- zero affected tenants at apply time, rollback is a no-op for tenant
-- resolved-vars in steady state. If a tenant was migrated onto one of
-- these keys between apply and rollback, REFRESH their snapshot afterwards
-- (scripts/refresh-snapshots.js --slug <slug>).
--
-- Safety:
--   * WHERE clause is restricted to the two specific keys + version=1.
--     If anyone has updated the row (version > 1), this script refuses
--     to delete it — surface a warning instead so a human can inspect.
--   * Wrapped in a transaction: COMMIT only after both deletes succeed.
--
-- Usage (from booking-backend root):
--   psql "$DATABASE_URL" -f scripts/themes_v2/04_rollback.sql
--
-- Affected keys (Phase 5.1 inserts):
--   minimal
--   boutique-beauty

BEGIN;

-- ── Pre-rollback inspection ─────────────────────────────────────────────
SELECT '── Pre-rollback state ──' AS info;

SELECT key,
       name,
       is_published,
       version,
       layout_key,
       (SELECT COUNT(*) FROM jsonb_object_keys(tokens_json)) AS token_count
  FROM platform_themes
 WHERE key IN ('minimal', 'boutique-beauty');

-- Surface any version drift (rows that have been updated since insert).
-- If this returns rows, the DELETE below will leave them alone — a human
-- needs to decide whether to delete or keep the modifications.
SELECT '── Rows with version > 1 (will NOT be deleted) ──' AS info;

SELECT key, name, version, is_published
  FROM platform_themes
 WHERE key IN ('minimal', 'boutique-beauty')
   AND version > 1;

-- ── Delete only pristine v1 rows ────────────────────────────────────────
DELETE FROM platform_themes
 WHERE key IN ('minimal', 'boutique-beauty')
   AND version = 1;

-- ── Post-rollback inspection ────────────────────────────────────────────
SELECT '── Post-rollback state ──' AS info;

SELECT key, name, version, is_published
  FROM platform_themes
 WHERE key IN ('minimal', 'boutique-beauty');

-- Should return 0 (or only rows with version > 1 that we refused to touch).
SELECT '── Remaining row count ──' AS info;

SELECT COUNT(*) AS remaining_in_scope
  FROM platform_themes
 WHERE key IN ('minimal', 'boutique-beauty');

COMMIT;
