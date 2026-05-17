-- ============================================================================
-- Migration 060 — TOMBSTONE / Numbering gap
-- ============================================================================
-- This migration number was skipped during development. There is no actual
-- migration file 060_*.sql, and no schema change associated with this number.
--
-- This file exists solely as a tombstone to:
--   (a) Make the gap visible to anyone listing migration files
--   (b) Prevent accidental re-use of the number for a future migration
--   (c) Document the gap for schema-drift audits
--
-- The migration runner will pick this up and apply it (no-op), inserting
-- a row into schema_migrations so subsequent audits don't flag 060 as
-- missing.
--
-- DO NOT add SQL to this file. If you need a new migration, use the next
-- available number (072+ as of 2026-05-17).
-- ============================================================================

SELECT 1 AS tombstone;  -- no-op, just to make the runner happy
