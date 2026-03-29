-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 020: Staff profile fields
-- Adds rich profile columns to the staff table.
-- All columns are nullable so existing rows are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS title_prefix        TEXT,
  ADD COLUMN IF NOT EXISTS display_name        TEXT,
  ADD COLUMN IF NOT EXISTS headline            TEXT,
  ADD COLUMN IF NOT EXISTS bio                 TEXT,
  ADD COLUMN IF NOT EXISTS certifications      TEXT,
  ADD COLUMN IF NOT EXISTS languages           TEXT,
  ADD COLUMN IF NOT EXISTS years_experience    INTEGER;

COMMENT ON COLUMN staff.title_prefix     IS 'Honorific prefix shown before the name (e.g. Dr., Prof.)';
COMMENT ON COLUMN staff.display_name     IS 'Public display name override. If null, title_prefix + name is used.';
COMMENT ON COLUMN staff.headline         IS 'One-line professional tagline shown on booking cards (max ~160 chars).';
COMMENT ON COLUMN staff.bio              IS 'Full multi-paragraph biography shown on the public staff profile.';
COMMENT ON COLUMN staff.certifications   IS 'Credentials, degrees, and licences (free text, one per line recommended).';
COMMENT ON COLUMN staff.languages        IS 'Languages spoken, comma-separated (e.g. Arabic, English, French).';
COMMENT ON COLUMN staff.years_experience IS 'Years of professional experience.';
