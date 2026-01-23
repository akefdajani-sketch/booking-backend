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

  // Booking pills grid + helper box
  "--bf-pill-grid-gap",
  "--bf-helper-radius",
  "--bf-helper-pad-y",
  "--bf-helper-pad-x",

  // Pill hover / active feedback
  "--bf-pill-hover-filter",
  "--bf-pill-hover-translate",
  "--bf-pill-hover-scale",
  "--bf-pill-hover-shadow",
  "--bf-pill-active-filter",
  "--bf-pill-active-translate",
  "--bf-pill-active-scale",
  "--bf-pill-active-shadow",
  "--bf-pill-selected-hover-filter",
  "--bf-pill-selected-hover-translate",
  "--bf-pill-selected-hover-scale",
  "--bf-pill-selected-hover-shadow",
  "--bf-pill-selected-active-filter",
  "--bf-pill-selected-active-translate",
  "--bf-pill-selected-active-scale",
  "--bf-pill-selected-active-shadow",

  // Reservations spacing
  "--bf-section-gap-sm",
  "--bf-res-scroller-maxh",
  "--bf-res-scroller-pr",
  "--bf-res-item-py",
  "--bf-res-item-gap",
  "--bf-outline-pill-py",
  "--bf-outline-pill-px",
  "--bf-outline-pill-fs",

  // Account spacing
  "--bf-account-pill-py",
  "--bf-account-pill-px",
  "--bf-account-pill-fs",
  "--bf-account-pill-h",
  "--bf-account-outline-pill-py",
  "--bf-account-outline-pill-px",
  "--bf-account-solid-pill-py",
  "--bf-account-solid-pill-px",

  // Modal sizing (Theme Studio)
  "--bf-modal-max-w",
  "--bf-modal-blur",
]);

// Brand + semantic variables that tenants may override safely.
// Note: Some of these are "back-compat" aliases used by older components.
const BRAND_OVERRIDE_KEYS = new Set([
  // Brand
  "--bf-brand-primary",
  "--bf-brand-primary-dark",
  // Focus ring (used by booking + owner UI)
  "--bf-focus-ring",

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
  "--bf-card-shadow",

  // Controls
  "--bf-control-bg",
  "--bf-control-text",
  "--bf-control-border",
  "--bf-control-focus-border",
  "--bf-control-focus-bg",
  "--bf-label-weight",
  "--bf-value-weight",
  "--bf-rich-select",

  // Pills
  "--bf-pill-bg",
  "--bf-pill-hover-bg",
  "--bf-pill-border",
  "--bf-pill-text",
  "--bf-pill-selected-bg",
  "--bf-pill-selected-border",
  "--bf-pill-selected-text",
  "--bf-pill-selected-shadow",
  // Selected pill glow/shadow
  "--bf-pill-selected-shadow",

  // Disabled pill tokens (Premium theme)
  "--bf-pill-disabled-bg",
  "--bf-pill-disabled-text",
  "--bf-pill-disabled-border",

  // Buttons
  "--bf-btn-bg",
  "--bf-btn-border",
  "--bf-btn-text",
  "--bf-btn-active-bg",
  "--bf-btn-active-text",
  "--bf-btn-secondary-bg",
  "--bf-btn-secondary-text",
  "--bf-btn-ghost-text",
  "--bf-btn-ghost-hover-bg",
  "--bf-btn-bg-disabled",
  "--bf-btn-text-disabled",

  // Navigation (Owner/Tenant side drawer)
  "--bf-nav-item-text",
  "--bf-nav-hover-bg",
  "--bf-nav-active-bg",
  "--bf-nav-active-text",

  // Semantic colors
  "--bf-danger",
  "--bf-danger-bg",
  "--bf-danger-border",
  "--bf-success",
  "--bf-success-bg",
  "--bf-success-border",
  "--bf-warning",
  "--bf-warning-bg",
  "--bf-warning-border",
  "--bf-info",
  "--bf-info-bg",
  "--bf-info-border",
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

  // Feature flags
  "--bf-rich-select",

  // Modal backdrop (Theme Studio)
  "--bf-modal-backdrop",
]);

module.exports = { THEME_TOKEN_KEYS, BRAND_OVERRIDE_KEYS };
