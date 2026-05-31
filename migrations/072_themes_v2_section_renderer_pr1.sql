-- Migration 072: THEMES-V2 Phase 5.3 PR-1 — render_mode + section-type catalog growth
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- PR-1 of Phase 5.3 wires a frontend <SectionRenderer /> for the book tab
-- behind a feature flag (branding.bookingUi.useSectionRenderer, default
-- FALSE). This migration is the backend half: it extends the platform_layouts
-- contract with two additive shapes so PR-1 frontend code has something well-
-- typed to read, without changing what any tenant actually renders.
--
-- Two things change in the catalog; nothing changes in the active section
-- list or any tenant row.
--
-- 1) platform_layouts.render_mode (new column, TEXT NOT NULL DEFAULT
--    'stacked_static'). Tells the frontend renderer which dispatch mode to
--    use. PR-1 only implements 'stacked_static'. Future render modes
--    ('stacked_progressive', 'wizard') will be introduced in PR-2/PR-3.
--    legacy_default keeps the new default — stacked_static — which is the
--    current rendering behavior.
--
-- 2) platform_layouts.supported_section_types_json for the legacy_default
--    seed expands from 8 entries to 11. Adds category_selector,
--    staff_selector, resource_selector to the *type catalog* — these are
--    registered but NOT inserted into sections_json. service_grid stays
--    (Phase 3.4 follow-up). customer_form keeps its current name in PR-1
--    (the confirm_summary rename is deferred to PR-2 alongside the
--    component extraction, so this migration remains a pure no-op for
--    existing reads).
--
-- 3) platform_layouts.sections_json for legacy_default is INTENTIONALLY
--    UNCHANGED. PR-1 must produce zero behavior change. The active 7-section
--    service-first order is preserved exactly:
--      nav_header, hero, service_selector, date_picker, time_slots,
--      customer_form, footer.
--
-- ─── ZERO BEHAVIOR CHANGE GUARANTEE ──────────────────────────────────────────
--
-- * No row in `tenants` is touched. shell_key and layout_key_v2 remain NULL
--   for every tenant in production (confirmed pre-072: 0/27 set).
-- * legacy_default.sections_json is unchanged byte-for-byte. The frontend
--   flag remains OFF; the SectionRenderer path is not exercised on any
--   tenant by this migration.
-- * publicTenantTheme.js will additionally surface layout.render_mode in
--   its response after this migration applies. supported_section_types_json
--   grows from 8 entries to 11. Both changes are additive — pre-PR-1
--   frontend code ignores both fields.
--
-- ─── IDEMPOTENCY ─────────────────────────────────────────────────────────────
--
-- All statements are safe to re-run:
--   * ALTER TABLE ... ADD COLUMN IF NOT EXISTS for render_mode.
--   * UPDATE ... WHERE key='legacy_default' is a no-op once the catalog
--     already matches the target 11-entry list (the WHERE-clause guard
--     compares JSONB equality).
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--
-- BEGIN;
--   UPDATE platform_layouts
--      SET supported_section_types_json =
--          '[ "nav_header", "hero", "service_selector", "service_grid",
--             "date_picker", "time_slots", "customer_form", "footer" ]'::jsonb,
--          updated_at = now()
--    WHERE key = 'legacy_default';
--   ALTER TABLE platform_layouts DROP COLUMN IF EXISTS render_mode;
-- COMMIT;
--
-- Forward direction below.

BEGIN;

-- (1) Add render_mode column. TEXT NOT NULL DEFAULT 'stacked_static' so
-- every existing row picks up the legacy rendering mode automatically.
ALTER TABLE platform_layouts
  ADD COLUMN IF NOT EXISTS render_mode TEXT NOT NULL DEFAULT 'stacked_static';

COMMENT ON COLUMN platform_layouts.render_mode IS
  'Frontend SectionRenderer dispatch mode. PR-1 supports stacked_static only. Reserved future values: stacked_progressive, wizard. Default stacked_static = current production behavior.';

-- (2) Expand the type catalog for legacy_default. Final 11-entry list adds
-- category_selector, staff_selector, resource_selector — registered as
-- known types so PR-2 can introduce their renderers without another
-- catalog migration. The UPDATE is idempotent: the WHERE guard makes
-- this a no-op once the catalog already matches.
UPDATE platform_layouts
   SET supported_section_types_json = '[
         "category_selector",
         "nav_header",
         "hero",
         "service_selector",
         "staff_selector",
         "resource_selector",
         "service_grid",
         "date_picker",
         "time_slots",
         "customer_form",
         "footer"
       ]'::jsonb,
       updated_at = now()
 WHERE key = 'legacy_default'
   AND supported_section_types_json <> '[
         "category_selector",
         "nav_header",
         "hero",
         "service_selector",
         "staff_selector",
         "resource_selector",
         "service_grid",
         "date_picker",
         "time_slots",
         "customer_form",
         "footer"
       ]'::jsonb;

-- (3) sections_json INTENTIONALLY UNCHANGED. Documented above; do not edit
-- here even to "normalize whitespace" — keep PR-1 a pure no-op on the
-- active section list.

-- ─── verify (commented) ──────────────────────────────────────────────────
-- After applying, the following query must return one row with:
--   render_mode = 'stacked_static'
--   jsonb_array_length(sections_json) = 7
--   jsonb_array_length(supported_section_types_json) = 11
--
-- SELECT key,
--        render_mode,
--        jsonb_array_length(sections_json)                 AS active_count,
--        jsonb_array_length(supported_section_types_json)  AS catalog_count
--   FROM platform_layouts
--  WHERE key = 'legacy_default';

COMMIT;
