-- Migration 073: THEMES-V2 Phase 5.3 PR-2 — sections_json reorder + customer_form -> confirm_summary rename
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- PR-2 of Phase 5.3 extracts the four selectors out of the monolithic
-- BookingFieldSelectors.tsx into independent peer section components
-- (DateSelectorSection, ServiceSelectorSection, StaffSelectorSection,
-- ResourceSelectorSection) and adds a ConfirmSummarySection wrapper over
-- the existing BookingConfirmSection. Migration 073 is the backend half:
-- it rewrites the ACTIVE sections_json for legacy_default to encode the
-- new four-peer layout in TODAY-order, and renames customer_form ->
-- confirm_summary in BOTH the {id:"form"} active entry AND the catalog.
--
-- Two distinct parts:
--
-- 1) platform_layouts.sections_json for legacy_default goes from 7 entries
--    to 9. The single {id:"services", type:"service_selector"} entry
--    becomes four contiguous peers in today's on-page render order:
--      date_picker, service_selector, staff_selector, resource_selector.
--    The id "services" is also renamed to "service" so the per-entry id
--    matches the singular-noun pattern of the other three (staff,
--    resource, date). The {id:"form"} entry's type is renamed
--    customer_form -> confirm_summary (no id change). All other entries
--    (nav_header, hero, time_slots, footer) stay byte-identical to the
--    pre-073 row.
--
--    BEFORE (7 entries):
--      nav_header, hero, service_selector, date_picker, time_slots,
--      customer_form, footer
--    AFTER  (9 entries; today-order):
--      nav_header, hero, date_picker, service_selector, staff_selector,
--      resource_selector, time_slots, confirm_summary, footer
--
-- 2) platform_layouts.supported_section_types_json for legacy_default
--    renames customer_form -> confirm_summary (in-place; same position).
--    category_selector, staff_selector, resource_selector are already in
--    the catalog (added by 072), so catalog length stays 11. PR-2 does
--    NOT implement category_selector — its frontend SectionRenderer case
--    remains warn-and-null (deferred to PR-2.5); the catalog entry
--    persists from 072.
--
-- ─── ZERO BEHAVIOR CHANGE GUARANTEE ──────────────────────────────────────────
--
-- * No row in `tenants` is touched. shell_key and layout_key_v2 remain
--   NULL for every tenant in production (0/27 set as of PR-1 merge).
-- * The frontend feature flag (branding.bookingUi.useSectionRenderer)
--   stays OFF. PublicBookingClient does NOT consume sections_json yet —
--   the SectionRenderer is callable but unwired.
-- * sections_json appears in the route response (per 072) but no tenant
--   renders FROM it. Today's render path goes BookingFormCard ->
--   BookingFieldSelectors (now a thin shell) -> the four extracted
--   sections in hard-coded today-order. The PR-2 BFS thin shell and the
--   future SectionRenderer-driven path converge on identical JSX because
--   they both encode the same today-order.
-- * publicTenantTheme.js already surfaces sections_json + render_mode +
--   supported_section_types_json (from 072 + the pre-072 contract);
--   after this migration the JSON CONTENT changes but the field SHAPES
--   are unchanged. Pre-PR-1 frontend code ignores sections_json entirely.
--
-- ─── IDEMPOTENCY ─────────────────────────────────────────────────────────────
--
-- Both UPDATEs are guarded by JSONB value-equality compares in the WHERE
-- clause (same pattern as 072's catalog UPDATE). A second apply is a
-- no-op because the WHERE evaluates false once the row already matches
-- the SET literal.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--
-- BEGIN;
--   UPDATE platform_layouts
--      SET sections_json = '[
--            { "id": "nav",      "type": "nav_header",       "enabled": true },
--            { "id": "hero",     "type": "hero",             "enabled": true },
--            { "id": "services", "type": "service_selector", "enabled": true },
--            { "id": "date",     "type": "date_picker",      "enabled": true },
--            { "id": "time",     "type": "time_slots",       "enabled": true },
--            { "id": "form",     "type": "customer_form",    "enabled": true },
--            { "id": "footer",   "type": "footer",           "enabled": true }
--          ]'::jsonb,
--          supported_section_types_json = '[
--            "category_selector",
--            "nav_header",
--            "hero",
--            "service_selector",
--            "staff_selector",
--            "resource_selector",
--            "service_grid",
--            "date_picker",
--            "time_slots",
--            "customer_form",
--            "footer"
--          ]'::jsonb,
--          updated_at = now()
--    WHERE key = 'legacy_default';
-- COMMIT;
--
-- ─── NOTE on active_count ────────────────────────────────────────────────────
--
-- active_count goes 7 -> 9 by design. PR-1's verify expected count
-- stability (active stayed at 7, catalog stayed at 11). PR-2
-- intentionally grows sections_json from 7 -> 9 entries — the single
-- service_selector entry becomes four contiguous peers in today-order
-- (date_picker, service_selector, staff_selector, resource_selector),
-- which is +2 net relative to the BEFORE since date_picker was already
-- present (now repositioned) and the other three are new entries.
-- Catalog stays at 11 (customer_form -> confirm_summary is a rename, no
-- add or remove). The proof gate is content-diff equality on the
-- BEFORE/AFTER CSV, NOT count stability.
--
-- Forward direction below.

BEGIN;

-- (1) Rewrite the ACTIVE sections_json for legacy_default.
-- BEFORE (7 entries) -> AFTER (9 entries; today-order).
-- The WHERE guard makes this a no-op once sections_json already matches.
UPDATE platform_layouts
   SET sections_json = '[
         { "id": "nav",      "type": "nav_header",        "enabled": true },
         { "id": "hero",     "type": "hero",              "enabled": true },
         { "id": "date",     "type": "date_picker",       "enabled": true },
         { "id": "service",  "type": "service_selector",  "enabled": true },
         { "id": "staff",    "type": "staff_selector",    "enabled": true },
         { "id": "resource", "type": "resource_selector", "enabled": true },
         { "id": "time",     "type": "time_slots",        "enabled": true },
         { "id": "form",     "type": "confirm_summary",   "enabled": true },
         { "id": "footer",   "type": "footer",            "enabled": true }
       ]'::jsonb,
       updated_at = now()
 WHERE key = 'legacy_default'
   AND sections_json <> '[
         { "id": "nav",      "type": "nav_header",        "enabled": true },
         { "id": "hero",     "type": "hero",              "enabled": true },
         { "id": "date",     "type": "date_picker",       "enabled": true },
         { "id": "service",  "type": "service_selector",  "enabled": true },
         { "id": "staff",    "type": "staff_selector",    "enabled": true },
         { "id": "resource", "type": "resource_selector", "enabled": true },
         { "id": "time",     "type": "time_slots",        "enabled": true },
         { "id": "form",     "type": "confirm_summary",   "enabled": true },
         { "id": "footer",   "type": "footer",            "enabled": true }
       ]'::jsonb;

-- (2) Rename customer_form -> confirm_summary in the catalog. Same 11
-- entries, same positions. category_selector, staff_selector, and
-- resource_selector were already added by 072 — this migration does NOT
-- grow the catalog; it only renames the customer_form slot.
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
         "confirm_summary",
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
         "confirm_summary",
         "footer"
       ]'::jsonb;

-- ─── verify (commented) ──────────────────────────────────────────────────
-- After applying, the following query must return one row with:
--   render_mode                                      = 'stacked_static'  (unchanged from 072)
--   jsonb_array_length(sections_json)                = 9                 (was 7)
--   jsonb_array_length(supported_section_types_json) = 11                (unchanged)
--
-- SELECT key,
--        render_mode,
--        jsonb_array_length(sections_json)                 AS active_count,
--        jsonb_array_length(supported_section_types_json)  AS catalog_count
--   FROM platform_layouts
--  WHERE key = 'legacy_default';

COMMIT;
