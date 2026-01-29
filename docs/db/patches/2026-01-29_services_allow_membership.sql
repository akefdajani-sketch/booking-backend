-- Patch: Service-level membership eligibility
-- Date: 2026-01-29
-- Why: Control which services can consume membership credits (e.g., allow Golf/Mini-Golf, block Karaoke/Lessons)
-- Safe: additive column with default false (no behavior change until enabled)

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS allow_membership boolean NOT NULL DEFAULT false;

-- Optional: if you want existing services to default ON, run one of these manually:
-- UPDATE services SET allow_membership = true WHERE name ILIKE '%golf%';
