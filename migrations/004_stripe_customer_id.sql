-- migrations/004_stripe_customer_id.sql
-- PR-4: Stripe Billing Wiring
--
-- Adds stripe_customer_id to tenants table.
-- Safe to run multiple times (IF NOT EXISTS / idempotent).
--
-- Run via: psql $DATABASE_URL -f migrations/004_stripe_customer_id.sql

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- Index for fast webhook lookups by customer id
CREATE INDEX IF NOT EXISTS idx_tenants_stripe_customer_id
  ON tenants (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
