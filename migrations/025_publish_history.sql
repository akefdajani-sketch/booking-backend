-- Migration 025: publish history (one-step rollback)
-- Adds branding_published_prev column to store the snapshot that was live
-- BEFORE the most recent publish. Enables a single "undo last publish" operation.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS branding_published_prev  jsonb    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS branding_published_prev_at timestamptz DEFAULT NULL;

COMMENT ON COLUMN tenants.branding_published_prev IS
  'The branding_published snapshot that was overwritten by the most recent publish. Used for one-step rollback.';
COMMENT ON COLUMN tenants.branding_published_prev_at IS
  'Timestamp of the publish that was rolled back (i.e. when branding_published_prev was the live version).';
