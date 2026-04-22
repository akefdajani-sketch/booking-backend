-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 038: Demo tenant flag
--
-- Adds a boolean column to tenants so demo-reset operations can be scoped
-- safely. The nightly demo-reset job wipes bookings/customers/memberships
-- ONLY for rows where is_demo = true. Any production tenant that keeps the
-- default value of false is completely unaffected.
--
-- Rationale: a seed/reset script that relies on slug matching
-- ("WHERE slug LIKE 'demo-%'") is one typo away from disaster.
-- A dedicated boolean is a hard firewall — SQL can't accidentally treat
-- Birdie Golf as a demo tenant.
--
-- All statements are idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.is_demo IS
  'Demo tenant marker. Nightly reset jobs operate ONLY on rows where this is true. Production tenants always leave this false.';

CREATE INDEX IF NOT EXISTS idx_tenants_is_demo
  ON tenants (is_demo)
  WHERE is_demo = true;

COMMIT;
