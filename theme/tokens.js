/**
 * theme/validateTokens.js (CommonJS)
 * Sanitizes tokens to a strict whitelist and basic value validation.
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
    key.includes("blur") ||
    key === "--bf-card-mt" ||
    key === "--bf-card-mb"
  ) return RX_PX.test(v);

  // Colors
  if (
    key.includes("bg") ||
    key.includes("border") ||
    key.includes("brand") ||
    key.includes("on-primary") ||
    key === "--bf-page-bg"
  ) return RX_COLOR.test(v);

  // Font family: keep conservative (no braces/semicolons)
  if (key === "--bf-font-family") {
    return v.length <= 80 && !/[;{}]/.test(v);
  }

  // Shadows/glass strings: allow but block braces/semicolons
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
