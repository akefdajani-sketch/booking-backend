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
    key.includes("translate") ||
    key.includes("maxh") ||
    key.includes("maxw") ||
    key.includes("blur") ||
    key.includes("mt") ||
    key.includes("mb") ||
    key.endsWith("-fs") ||
    key.endsWith("-px") ||
    key.endsWith("-py") ||
    key.endsWith("-pr")
  ) {
    return RX_PX.test(v);
  }

  // Scale tokens (unitless)
  if (key.endsWith("-scale")) {
    if (!/^\d+(\.\d+)?$/.test(v)) return false;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0.8 && n <= 1.2;
  }

  // Filter tokens (conservative: block braces/semicolons)
  if (key.endsWith("-filter")) {
    return v.length <= 80 && !/[;{}]/.test(v);
  }

  // Shadow tokens (conservative: block braces/semicolons)
  if (key.endsWith("-shadow")) {
    return v.length <= 200 && !/[;{}]/.test(v);
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

  // Label/value weights (Premium form typography): numeric string 100-900
  if (key === "--bf-label-weight" || key === "--bf-value-weight") {
    const n = Number(v);
    return Number.isFinite(n) && n >= 100 && n <= 900;
  }

  // Feature flags
  if (key === "--bf-rich-select") {
    return v === "0" || v === "1";
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
