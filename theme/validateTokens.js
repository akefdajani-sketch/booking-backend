import { THEME_TOKEN_KEYS, BRAND_OVERRIDE_KEYS } from "./tokens.js";

const RX_PX = /^\d+(\.\d+)?px$/;
const RX_COLOR = /^(#([0-9a-fA-F]{3}){1,2}|rgba?\([^)]+\))$/;

function isSafeValue(key, val) {
  if (typeof val !== "string") return false;
  const v = val.trim();

  // sizes
  if (
    key.includes("radius") ||
    key.includes("pad") ||
    key.includes("gap") ||
    key.includes("height") ||
    key.includes("blur") ||
    key.includes("mt") ||
    key.includes("mb")
  ) return RX_PX.test(v);

  // colors
  if (key.includes("bg") || key.includes("border") || key.includes("brand") || key.includes("on-primary"))
    return RX_COLOR.test(v);

  // fonts: keep strict
  if (key === "--bf-font-family") {
    // optionally replace with allowlist:
    // return ["Inter", "system-ui", ...].some(...)
    return v.length <= 80 && !v.includes(";") && !v.includes("{") && !v.includes("}");
  }

  // shadow/glass: best to only allow presets (recommended)
  if (key === "--bf-shadow" || key === "--bf-glass") {
    return v.length <= 200 && !v.includes(";") && !v.includes("{") && !v.includes("}");
  }

  return false;
}

export function sanitizeThemeTokens(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;

  for (const [k, v] of Object.entries(input)) {
    if (!THEME_TOKEN_KEYS.has(k)) continue;
    if (!isSafeValue(k, v)) continue;
    out[k] = v.trim();
  }
  return out;
}

export function sanitizeBrandOverrides(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;

  for (const [k, v] of Object.entries(input)) {
    if (!BRAND_OVERRIDE_KEYS.has(k)) continue;
    if (!isSafeValue(k, v)) continue;
    out[k] = v.trim();
  }
  return out;
}
