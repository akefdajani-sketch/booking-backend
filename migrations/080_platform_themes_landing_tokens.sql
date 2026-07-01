-- 080: Landing design-token system, PR-A.
-- Adds a nullable JSONB column on platform_themes to hold landing-page design
-- tokens as a separate blob from tokens_json. Kept OUT of tokens_json so the
-- isFlatCssVarMap gate in theme/resolveTenantAppearanceSnapshot.js:564 never
-- sees non-"--bf-*" keys (which would collapse the whole platform token map).
--
-- The snapshot builder reads this column and emits it as `landingTokens` in
-- appearance_snapshot_published_json — sibling of themeStudioTokens, distinct
-- from the existing `landing` object key (which carries showPattern/templateKey).
--
-- NO BEGIN/COMMIT — same convention as 074+ (migrate runner or DBeaver wraps
-- execution). Additive + idempotent: guarded with IF NOT EXISTS.

ALTER TABLE platform_themes
  ADD COLUMN IF NOT EXISTS landing_tokens_json JSONB NULL;

COMMENT ON COLUMN platform_themes.landing_tokens_json IS
  'PR-A: landing-page design tokens for this platform theme. Nested JSON allowed (unlike tokens_json which is a flat --bf-* map gated by isFlatCssVarMap in the snapshot builder). Emitted as snapshot.landingTokens when non-empty. Populated via DBeaver in PR-A; admin-route sanitizer will be added in a later PR.';
