-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 059: Tenant voice instructions
--
-- Adds a per-tenant text field that gets injected into the ElevenLabs agent's
-- system prompt as an override. Lets each tenant flex the assistant's tone /
-- personality / domain quirks (e.g. Birdie says "Thanks for choosing Birdie
-- Golf — let me know if you'd like the longest tee time first") on top of the
-- shared base instructions configured in the ElevenLabs dashboard.
--
-- Empty string / NULL means "no override" — the agent uses its base prompt
-- only. The override is wrapped in a clear "TENANT-SPECIFIC PREFERENCES"
-- preamble at runtime so the agent treats it additively, not destructively.
--
-- Mirrors the pattern from clawbot's voice integration. See routes/voice.js
-- for the runtime injection.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS voice_instructions TEXT;

COMMIT;

-- Verification:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'tenants' AND column_name = 'voice_instructions';
