-- Migration 068: THEMES-V2 / FLOW-ENGINE Phase 2.1 — booking_flow_preset
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────────
--
-- Adds the booking flow preset column at two granularities:
--
--   tenants.booking_flow_preset    — tenant-level preset (default 'date-first')
--   services.booking_flow_preset   — per-service override (default NULL = inherit)
--
-- The flow engine itself ships in Phase 2.2 (lib/booking/flow/*) and is
-- gated behind a feature flag. The wizard reads these columns once the
-- flag flips. Until then, both columns exist but are not consumed.
--
-- The 4 Phase A presets are:
--   'date-first'        — current Birdie/classic behavior (date → service → time)
--   'service-first'     — service → date → time (catalog-first)
--   'resource-first'    — resource → date → slot (rentals/marketplace)
--   'specialist-first'  — specialist → service → date → time (clinics/beauty)
--
-- Per OQ-4 sign-off (2026-05-10): services.booking_flow_preset ships now,
-- unused, to front-load the schema and avoid a second migration when
-- Phase C (visual composer) lands. NULL = inherit tenant default.
--
-- Per OQ-6 sign-off: anchor tenants migrate immediately upon Phase 3 ship.
-- For Phase 2.1, NO tenants change preset — every tenant defaults to
-- 'date-first', which matches existing behavior bit-for-bit.
--
-- ─── ZERO BEHAVIOR CHANGE ────────────────────────────────────────────────────
--
-- This migration is purely additive:
--   - Existing booking flows continue exactly as today
--   - Frontend wizard ignores these columns until flow engine ships
--   - Tenant defaults to 'date-first' (= current default flow)
--   - Service defaults to NULL (= inherit tenant)
--   - Adding the columns to API responses is Phase 2.2; no API changes here
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--
-- BEGIN;
-- ALTER TABLE services DROP CONSTRAINT IF EXISTS services_booking_flow_preset_check;
-- ALTER TABLE services DROP COLUMN IF EXISTS booking_flow_preset;
-- ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_booking_flow_preset_check;
-- ALTER TABLE tenants DROP COLUMN IF EXISTS booking_flow_preset;
-- COMMIT;

BEGIN;

-- ─── Tenant-level preset ─────────────────────────────────────────────────────

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS booking_flow_preset TEXT NOT NULL DEFAULT 'date-first';

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_booking_flow_preset_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_booking_flow_preset_check
  CHECK (booking_flow_preset IN (
    'date-first', 'service-first', 'resource-first', 'specialist-first'
  ));

COMMENT ON COLUMN tenants.booking_flow_preset IS
  'Tenant-level booking flow preset. Defaults to date-first (current Birdie behavior). Set via owner Setup → Appearance once Phase 2.2 flow engine ships. Constrained to the 4 Phase A presets.';

-- ─── Service-level override (NULL = inherit tenant default) ──────────────────

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS booking_flow_preset TEXT NULL;

ALTER TABLE services
  DROP CONSTRAINT IF EXISTS services_booking_flow_preset_check;

ALTER TABLE services
  ADD CONSTRAINT services_booking_flow_preset_check
  CHECK (
    booking_flow_preset IS NULL
    OR booking_flow_preset IN (
      'date-first', 'service-first', 'resource-first', 'specialist-first'
    )
  );

COMMENT ON COLUMN services.booking_flow_preset IS
  'Per-service flow override. NULL = use tenant default. Reserved for Phase C (visual flow composer); not surfaced in UI in Phase A. Front-loaded per OQ-4 sign-off to avoid a second migration when composer lands.';

COMMIT;
