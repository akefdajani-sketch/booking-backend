-- 005_soft_delete.sql
-- Adds soft-delete support to customers and services tables.
-- Bookings are already soft-deleted via status='cancelled'.
-- Run: psql $DATABASE_URL -f migrations/005_soft_delete.sql
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- These use plain CREATE INDEX (safe for migrations inside BEGIN/COMMIT).

BEGIN;

-- ── customers: soft delete ──────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Partial index: only non-deleted customers in normal queries
CREATE INDEX IF NOT EXISTS idx_customers_active
  ON customers(tenant_id, id)
  WHERE deleted_at IS NULL;

-- ── services: soft delete ────────────────────────────────────────────────────
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Partial index: only non-deleted services
CREATE INDEX IF NOT EXISTS idx_services_active
  ON services(tenant_id, id)
  WHERE deleted_at IS NULL;

-- ── Audit views ──────────────────────────────────────────────────────────────
-- Quick view for admin tooling — shows all soft-deleted rows
CREATE OR REPLACE VIEW deleted_customers AS
  SELECT id, tenant_id, name, email, phone, deleted_at
  FROM customers
  WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE VIEW deleted_services AS
  SELECT id, tenant_id, name, deleted_at
  FROM services
  WHERE deleted_at IS NOT NULL;

COMMIT;
