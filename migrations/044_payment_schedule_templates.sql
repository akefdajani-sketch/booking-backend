-- migrations/044_payment_schedule_templates.sql
-- G2a-1: Long-term contracts — reusable payment milestone templates.
--
-- A template defines a sequence of milestones (e.g. "25% deposit at
-- signing + 3 monthly installments"). When a contract is created from
-- a template, the milestones are *exploded* into concrete
-- contract_invoices rows with frozen amounts and due_dates.
--
-- The contract holds an immutable JSONB snapshot of what was applied
-- (contracts.payment_schedule_snapshot in migration 045). Edits to the
-- template do NOT retroactively change existing contracts.
--
-- Platform defaults (tenant_id IS NULL, is_system = TRUE) are seeded in
-- migration 048. Tenants can clone platform rows but API must reject
-- direct edits/deletes of is_system rows.
--
-- Milestone JSONB shape (one object per milestone):
--   {
--     "label":             "Deposit" | "Month 1" | "Check-in" | ...,
--     "percent":           <number, 0–100>,
--     "trigger":           "signing" | "check_in" | "mid_stay"
--                        | "monthly_on_first" | "monthly_relative",
--     "due_offset_days":   <int>       // for signing/check_in/mid_stay
--     "months_after_start":<int>       // for monthly_on_first
--   }
--   Percents across all milestones in a template must sum to 100.
--   The code that explodes milestones into invoices handles rounding
--   (assigns residual cents to the last milestone).
--
-- Fully idempotent.

CREATE TABLE IF NOT EXISTS payment_schedule_templates (
  id                BIGSERIAL    PRIMARY KEY,
  tenant_id         INTEGER      REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT         NOT NULL,
  description       TEXT,
  stay_type_scope   TEXT         NOT NULL DEFAULT 'any',
  milestones        JSONB        NOT NULL,
  is_default        BOOLEAN      NOT NULL DEFAULT FALSE,
  is_system         BOOLEAN      NOT NULL DEFAULT FALSE,
  active            BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by        INTEGER      REFERENCES staff(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_pst_stay_type_scope
    CHECK (stay_type_scope IN ('any','long_stay','contract_stay')),
  CONSTRAINT chk_pst_milestones_is_array
    CHECK (jsonb_typeof(milestones) = 'array'),
  CONSTRAINT chk_pst_milestones_not_empty
    CHECK (jsonb_array_length(milestones) >= 1),
  CONSTRAINT chk_pst_system_is_platform
    CHECK (is_system = FALSE OR tenant_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_pst_tenant_scope
  ON payment_schedule_templates (tenant_id, stay_type_scope)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_pst_platform_defaults
  ON payment_schedule_templates (stay_type_scope)
  WHERE tenant_id IS NULL AND active = TRUE;

-- At most one default per (tenant_id, stay_type_scope).
-- COALESCE(tenant_id, 0) treats platform defaults as their own bucket.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pst_default_per_scope
  ON payment_schedule_templates (COALESCE(tenant_id, 0), stay_type_scope)
  WHERE is_default = TRUE AND active = TRUE;

COMMENT ON TABLE payment_schedule_templates IS
  'G2a: Reusable payment milestone structures. Platform defaults (tenant_id NULL, is_system true) seeded in migration 048.';
COMMENT ON COLUMN payment_schedule_templates.tenant_id IS
  'NULL = platform-level default (API must reject edit/delete if is_system=true). Non-null = tenant-owned.';
COMMENT ON COLUMN payment_schedule_templates.milestones IS
  'Ordered JSONB array. Each milestone has {label, percent, trigger, ...}. Percents sum to 100.';
COMMENT ON COLUMN payment_schedule_templates.is_default IS
  'Auto-selected when creating a contract matching stay_type_scope. Unique per (tenant_id, stay_type_scope).';
