/**
 * theme/tokens.js (CommonJS)
 *
 * Canonical allowlists for CSS variable overrides.
 *
 * Keep these in sync with frontend token usage:
 * - frontend: lib/theme/tokens.ts (theme layout tokens)
 * - frontend: lib/theme/TenantCssVarsProvider.tsx (brand/vars applied at runtime)
 */

// Layout / spacing tokens (used by cards/controls/pills)
const THEME_TOKEN_KEYS = new Set([
  "--bf-card-radius",
  "--bf-control-radius",
  "--bf-pill-radius",
  "--bf-btn-radius",
  "--bf-card-pad",
  "--bf-card-mt",
  "--bf-card-mb",
  "--bf-field-gap",
  "--bf-label-gap",
  "--bf-label-font",
  "--bf-control-font",
  "--bf-control-height",
  "--bf-control-pad-x",
]);

// Brand + semantic variables that tenants may override safely.
// Note: Some of these are "back-compat" aliases used by older components.
const BRAND_OVERRIDE_KEYS = new Set([
  // Brand
  "--bf-brand-primary",
  "--bf-brand-primary-dark",

  // Typography / page
  "--bf-font-family",
  "--bf-font-weight-heading",
  "--bf-font-weight-body",
  "--bf-page-bg",
  "--bf-text-main",
  "--bf-text-muted",
  "--bf-text-soft",

  // Card
  "--bf-card-bg",
  "--bf-card-border",

  // Pills
  "--bf-pill-bg",
  "--bf-pill-border",
  "--bf-pill-text",
  "--bf-pill-selected-bg",
  "--bf-pill-selected-border",
  "--bf-pill-selected-text",

  // Buttons
  "--bf-btn-bg",
  "--bf-btn-text",
  "--bf-btn-bg-disabled",
  "--bf-btn-text-disabled",

  // Semantic colors
  "--bf-danger",
  "--bf-danger-bg",
  "--bf-danger-border",
  "--bf-success",
  "--bf-success-bg",
  "--bf-success-border",
  "--bf-hero-text",

  // Density vars used for pill sizing on booking pages
  "--bf-pill-h",
  "--bf-pill-fs",
  "--bf-pill-px",

  // Back-compat aliases
  "--bf-text",
  "--bf-muted",
  "--bf-surface",
  "--bf-border",

  // Optional (kept for forwards/backwards compatibility)
  "--bf-shadow",
  "--bf-glass",
]);

module.exports = { THEME_TOKEN_KEYS, BRAND_OVERRIDE_KEYS };
