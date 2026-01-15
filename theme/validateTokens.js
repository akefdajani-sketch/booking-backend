/**
 * theme/validateTokens.js (CommonJS)
 *
 * Sanitizes tenant theming overrides to a strict whitelist of CSS variables.
 * This prevents arbitrary CSS injection while still allowing safe theming.
 */

const { THEME_TOKEN_KEYS, BRAND_OVERRIDE_KEYS } = require("./tokens");

const RX_PX = /^\d+(\.\d+)?px$/;
const RX_COLOR = /^(#([0-9a-fA-F]{3}){1,2}|rgba?\([^)]+\))$/;

function isSafeValue(key, val) {
  if (typeof val !== "string") return false;
  const v = val.trim();
  if (!v) return false;

  // Sizes in px
  if (
    key.includes("radius") ||
    key.includes("pad") ||
    key.includes("gap") ||
    key.includes("height") ||
    key.includes("width") ||
    key.includes("max-w") ||
    key.includes("blur") ||
    key.includes("mt") ||
    key.includes("mb") ||
    key.endsWith("-fs") ||
    key.endsWith("-px")
  ) {
    return RX_PX.test(v);
  }

  // Colors
  if (
    key.includes("bg") ||
    key.includes("border") ||
    key.includes("brand") ||
    key.includes("text") ||
    key === "--bf-page-bg"
  ) {
    return RX_COLOR.test(v);
  }

  // Font family: keep conservative (no braces/semicolons)
  if (key === "--bf-font-family") {
    return v.length <= 80 && !/[;{}]/.test(v);
  }

  // Font weights: numeric string 100-900
  if (key === "--bf-font-weight-heading" || key === "--bf-font-weight-body") {
    const n = Number(v);
    return Number.isFinite(n) && n >= 100 && n <= 900;
  }

  // Shadows/glass strings (if used): allow but block braces/semicolons
  if (key === "--bf-shadow" || key === "--bf-glass") {
    return v.length <= 200 && !/[;{}]/.test(v);
  }

  return false;
}

function sanitizeByWhitelist(input, whitelist) {
  const out = {};
  if (!input || typeof input !== "object") return out;

  for (const [k, v] of Object.entries(input)) {
    if (!whitelist.has(k)) continue;
    if (!isSafeValue(k, v)) continue;
    out[k] = String(v).trim();
  }
  return out;
}

function sanitizeThemeTokens(input) {
  return sanitizeByWhitelist(input, THEME_TOKEN_KEYS);
}

function sanitizeBrandOverrides(input) {
  return sanitizeByWhitelist(input, BRAND_OVERRIDE_KEYS);
}

module.exports = { sanitizeThemeTokens, sanitizeBrandOverrides };
