/**
 * theme/tokens.js (CommonJS)
 * Whitelists the CSS variables we allow to be stored/applied for platform themes
 * and a smaller subset for tenant brand overrides.
 */
const THEME_TOKEN_KEYS = new Set([
  "--bf-font-family",
  "--bf-label-font",
  "--bf-control-font",
  "--bf-heading-weight",

  "--bf-card-radius",
  "--bf-control-radius",
  "--bf-pill-radius",
  "--bf-btn-radius",

  "--bf-card-pad",
  "--bf-card-mt",
  "--bf-card-mb",

  "--bf-field-gap",
  "--bf-label-gap",

  "--bf-control-height",
  "--bf-control-pad-x",

  "--bf-card-bg",
  "--bf-card-border",
  "--bf-border",
  "--bf-shadow",
  "--bf-glass",

  "--bf-card-blur",
  "--bf-modal-blur"
]);

const BRAND_OVERRIDE_KEYS = new Set([
  "--bf-brand-primary",
  "--bf-on-primary",
  "--bf-page-bg",
  "--bf-card-bg"
]);

module.exports = { THEME_TOKEN_KEYS, BRAND_OVERRIDE_KEYS };
