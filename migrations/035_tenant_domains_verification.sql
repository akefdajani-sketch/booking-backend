-- migrations/035_tenant_domains_verification.sql
-- PR 129 — Domain verification state machine
--
-- Adds the columns needed to track a domain through the
-- pending → verifying → active / failed lifecycle spec'd in
-- frontend Patch 128 and Master Action Plan v2 §4.4.
--
-- Baseline (from earlier migrations / runtime-CREATE code):
--   tenant_domains.id              BIGSERIAL
--   tenant_domains.tenant_id       BIGINT NOT NULL
--   tenant_domains.domain          TEXT NOT NULL UNIQUE
--   tenant_domains.is_primary      BOOLEAN NOT NULL DEFAULT FALSE
--   tenant_domains.status          TEXT (historically always 'active')
--   tenant_domains.created_at      TIMESTAMPTZ
--   tenant_domains.updated_at      TIMESTAMPTZ
--
-- Changes applied here:
--   1. verification_error TEXT — last failure message, surfaced on row card
--   2. last_verified_at   TIMESTAMPTZ — most recent verify attempt timestamp
--   3. (optional helper index on (tenant_id, status) for owner list queries)
--
-- Status vocabulary (enforced by application code, not the DB):
--   'pending'    — just inserted; DNS not yet verified
--   'verifying'  — verification attempt in progress (short-lived)
--   'active'     — verified; domain serves booking traffic
--   'failed'     — verification attempted but DNS not configured correctly
--
-- Fully idempotent. Safe to run against production multiple times.

ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS verification_error TEXT;
ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS last_verified_at   TIMESTAMPTZ;

-- Helper index to speed up owner's domain list (scoped by tenant_id)
CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant_status
  ON tenant_domains (tenant_id, status);

-- Existing rows with status 'active' (or NULL) stay active — they were
-- manually created under the old flow and are presumed to serve traffic.
-- New rows created through the POST route go through the pending-first
-- flow from Patch 129 onward.

-- Guardrail: at most one primary domain per tenant.
-- A CHECK constraint can't enforce this directly (it's a cross-row
-- condition); a partial unique index does the job cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_domains_one_primary_per_tenant
  ON tenant_domains (tenant_id)
  WHERE is_primary = TRUE;

-- Verify column presence
DO $$
DECLARE
  col_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'tenant_domains'
      AND column_name IN ('verification_error', 'last_verified_at');
  IF col_count <> 2 THEN
    RAISE EXCEPTION 'migration 035: expected 2 new columns on tenant_domains, found %', col_count;
  END IF;
END $$;
