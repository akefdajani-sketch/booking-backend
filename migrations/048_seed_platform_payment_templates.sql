-- migrations/048_seed_platform_payment_templates.sql
-- G2a-1: Seed 4 platform-default payment schedule templates.
--
-- These are system rows: tenant_id IS NULL, is_system = TRUE.
-- Tenants see them in the picker alongside their own templates, can
-- clone to customize, but the API must reject edits/deletes of
-- is_system rows.
--
-- Percentages are chosen to sum to exactly 100 with whole-number
-- installments where possible (avoids seed-time rounding noise):
--
--   Long Stay 15-60 nights:  30 / 40 / 30                        (100)
--   3-Month Contract:        25 / 25 / 25 / 25                    (100)
--   6-Month Contract:        22 / 13×6                            (100)
--   12-Month Contract:       16 / 7×12                            (100)
--
-- Idempotent via ON CONFLICT on (tenant_id, name) WHERE tenant_id IS NULL.
-- Safe to re-run; will not overwrite tenant customizations (tenant rows
-- have tenant_id != NULL and are filtered out).

-- ─── Unique index to support ON CONFLICT for platform rows ────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_pst_platform_name
  ON payment_schedule_templates (name)
  WHERE tenant_id IS NULL;

-- ─── 1. Long Stay (15-60 nights) ──────────────────────────────────────────────
INSERT INTO payment_schedule_templates
  (tenant_id, name, description, stay_type_scope, milestones, is_default, is_system, active)
VALUES (
  NULL,
  'Platform: Long Stay (15-60 nights)',
  '30% deposit at signing, 40% at check-in, 30% mid-stay.',
  'long_stay',
  '[
    {"label":"Deposit",           "percent":30, "trigger":"signing",   "due_offset_days":0},
    {"label":"Check-in payment",  "percent":40, "trigger":"check_in",  "due_offset_days":0},
    {"label":"Mid-stay payment",  "percent":30, "trigger":"mid_stay",  "due_offset_days":0}
  ]'::jsonb,
  TRUE,
  TRUE,
  TRUE
)
ON CONFLICT (name) WHERE tenant_id IS NULL DO NOTHING;

-- ─── 2. 3-Month Contract ──────────────────────────────────────────────────────
INSERT INTO payment_schedule_templates
  (tenant_id, name, description, stay_type_scope, milestones, is_default, is_system, active)
VALUES (
  NULL,
  'Platform: 3-Month Contract',
  '25% deposit at signing, plus 3 equal monthly installments billed on the 1st.',
  'contract_stay',
  '[
    {"label":"Deposit",  "percent":25, "trigger":"signing",          "due_offset_days":0},
    {"label":"Month 1",  "percent":25, "trigger":"monthly_on_first", "months_after_start":0},
    {"label":"Month 2",  "percent":25, "trigger":"monthly_on_first", "months_after_start":1},
    {"label":"Month 3",  "percent":25, "trigger":"monthly_on_first", "months_after_start":2}
  ]'::jsonb,
  FALSE,
  TRUE,
  TRUE
)
ON CONFLICT (name) WHERE tenant_id IS NULL DO NOTHING;

-- ─── 3. 6-Month Contract ──────────────────────────────────────────────────────
INSERT INTO payment_schedule_templates
  (tenant_id, name, description, stay_type_scope, milestones, is_default, is_system, active)
VALUES (
  NULL,
  'Platform: 6-Month Contract',
  '22% deposit at signing, plus 6 equal monthly installments billed on the 1st.',
  'contract_stay',
  '[
    {"label":"Deposit",  "percent":22, "trigger":"signing",          "due_offset_days":0},
    {"label":"Month 1",  "percent":13, "trigger":"monthly_on_first", "months_after_start":0},
    {"label":"Month 2",  "percent":13, "trigger":"monthly_on_first", "months_after_start":1},
    {"label":"Month 3",  "percent":13, "trigger":"monthly_on_first", "months_after_start":2},
    {"label":"Month 4",  "percent":13, "trigger":"monthly_on_first", "months_after_start":3},
    {"label":"Month 5",  "percent":13, "trigger":"monthly_on_first", "months_after_start":4},
    {"label":"Month 6",  "percent":13, "trigger":"monthly_on_first", "months_after_start":5}
  ]'::jsonb,
  TRUE,  -- default for contract_stay (replaces 3-month as the chosen default; adjust in UI)
  TRUE,
  TRUE
)
ON CONFLICT (name) WHERE tenant_id IS NULL DO NOTHING;

-- ─── 4. 12-Month Contract ─────────────────────────────────────────────────────
INSERT INTO payment_schedule_templates
  (tenant_id, name, description, stay_type_scope, milestones, is_default, is_system, active)
VALUES (
  NULL,
  'Platform: 12-Month Contract',
  '16% deposit at signing, plus 12 equal monthly installments billed on the 1st.',
  'contract_stay',
  '[
    {"label":"Deposit",  "percent":16, "trigger":"signing",          "due_offset_days":0},
    {"label":"Month 1",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":0},
    {"label":"Month 2",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":1},
    {"label":"Month 3",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":2},
    {"label":"Month 4",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":3},
    {"label":"Month 5",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":4},
    {"label":"Month 6",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":5},
    {"label":"Month 7",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":6},
    {"label":"Month 8",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":7},
    {"label":"Month 9",  "percent":7,  "trigger":"monthly_on_first", "months_after_start":8},
    {"label":"Month 10", "percent":7,  "trigger":"monthly_on_first", "months_after_start":9},
    {"label":"Month 11", "percent":7,  "trigger":"monthly_on_first", "months_after_start":10},
    {"label":"Month 12", "percent":7,  "trigger":"monthly_on_first", "months_after_start":11}
  ]'::jsonb,
  FALSE,
  TRUE,
  TRUE
)
ON CONFLICT (name) WHERE tenant_id IS NULL DO NOTHING;

-- Verify: should return 4 rows
-- SELECT id, name, stay_type_scope, is_default FROM payment_schedule_templates
--   WHERE tenant_id IS NULL AND is_system = TRUE ORDER BY id;
