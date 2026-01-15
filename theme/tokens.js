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

  // layout + navigation
  "--bf-page-bg",
  "--bf-page-pad-top",
  "--bf-page-pad-x",
  "--bf-page-pad-bottom",
  "--bf-page-max-w",
  "--bf-page-content-mt",
  "--bf-page-hero-pad-top",
  "--bf-page-content-pad-top",

  "--bf-bottomnav-pad-top",
  "--bf-bottomnav-pad-bottom",
  "--bf-bottomnav-bg",
  "--bf-bottomnav-blur",
  "--bf-bottomnav-max-w",
  "--bf-bottomnav-item-pad",
  "--bf-bottomnav-item-gap",
  "--bf-bottomnav-font",
  "--bf-bottomnav-icon-box",
  "--bf-bottomnav-icon-size",
  "--bf-bottomnav-emoji-font",

  // hero
  "--bf-hero-mb",
  "--bf-hero-radius",
  "--bf-hero-shadow",
  "--bf-hero-media-h",
  "--bf-hero-pad",
  "--bf-hero-gap",
  "--bf-hero-label-fs",
  "--bf-hero-label-mb",
  "--bf-hero-title-fs",
  "--bf-hero-title-weight",
  "--bf-hero-member-fs",
  "--bf-hero-member-mt",
  "--bf-hero-avatar-size",
  "--bf-hero-avatar-fs",
  "--bf-hero-logo-size",
  "--bf-hero-subtext",
  "--bf-hero-right-gap",

  // selects / popovers
  "--bf-select-gap",
  "--bf-select-avatar",
  "--bf-select-avatar-fs",
  "--bf-popover-offset",
  "--bf-popover-bg",
  "--bf-popover-border",
  "--bf-popover-radius",
  "--bf-popover-shadow",
  "--bf-popover-blur",
  "--bf-popover-item-pad",
  "--bf-popover-max-h",

  // misc
  "--bf-signin-btn-pad",
  "--bf-signin-btn-fs",
  "--bf-avatar-btn-size",
  "--bf-avatar-btn-fs",
  "--bf-avatar-btn-weight",
  "--bf-avatar-btn-shadow",

  "--bf-home-title-fs",
  "--bf-home-title-mb",
  "--bf-home-body-fs",
  "--bf-home-body-mb",
  "--bf-home-list-fs",
  "--bf-home-list-mb",
  "--bf-home-list-pl",
  "--bf-home-note-fs",

  "--bf-details-header-gap",
  "--bf-details-title-fs",
  "--bf-details-subtitle-fs",
  "--bf-details-box-mt",
  "--bf-details-box-radius",
  "--bf-details-box-pad",
  "--bf-details-grid-gap",
  "--bf-details-label-fs",
  "--bf-details-label-mb",
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
