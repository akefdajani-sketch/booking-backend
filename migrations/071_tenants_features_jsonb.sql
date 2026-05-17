-- Migration 071 — tenants.features JSONB column for per-tenant feature flags.
--
-- Phase 2.3 introduces this column to gate the new brain+persona orchestrator
-- (utils/bookingBrain.js + utils/voicePersona.js) behind
-- tenants.features.voice_two_query=true. Phase 2.4 flips it on for Birdie Golf
-- and validates production; legacy single-prompt path runs unchanged for every
-- tenant whose flag is false/missing (default).
--
-- Future feature flags add additional keys to the same JSONB rather than new
-- columns. The hardcoded VOICE_PROMPT_FEATURE_SLUGS array in
-- utils/voiceContext.js can migrate to features.voice_prompt in a follow-up.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}'::jsonb NOT NULL;

COMMENT ON COLUMN tenants.features IS
  'Per-tenant feature flags (Phase 2.3+). Phase 2.3 adds features.voice_two_query (boolean) — when true, routes/ai.js + routes/voice.js route through the brain+persona orchestrator instead of the legacy single-prompt runSupportAgent. Default {}::jsonb means every tenant stays on legacy until explicitly flipped.';
