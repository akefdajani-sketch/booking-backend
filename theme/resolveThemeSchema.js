// Resolve a Theme Schema (v1) into:
// - derived values (tint/shade/mix/glow math)
// - a flat map of CSS variables that the UI can consume
//
// This file intentionally avoids external deps.

const { sanitizeBrandOverrides, sanitizeThemeTokens } = require("./validateTokens");

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function hexToRgb(hex) {
  const h = String(hex || "").trim().replace(/^#/, "");
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((x) => Number.isNaN(x))) return null;
  return { r, g, b };
}

function rgbToHex({ r, g, b }) {
  const toHex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const rr = toHex2(r);
  const gg = toHex2(g);
  const bb = toHex2(b);
  return `#${rr}${gg}${bb}`;
}

function mix(c1, c2, amount) {
  const a = clamp01(amount);
  const r1 = hexToRgb(c1);
  const r2 = hexToRgb(c2);
  if (!r1 || !r2) return c1;
  return rgbToHex({
    r: r1.r + (r2.r - r1.r) * a,
    g: r1.g + (r2.g - r1.g) * a,
    b: r1.b + (r2.b - r1.b) * a,
  });
}

function tint(hex, amount) {
  return mix(hex, "#ffffff", amount);
}

function shade(hex, amount) {
  return mix(hex, "#000000", amount);
}

function rgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(0,0,0,${clamp01(alpha)})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp01(alpha)})`;
}

function glowAlpha(intensity) {
  const v = String(intensity || "medium").toLowerCase();
  if (v === "soft") return 0.2;
  if (v === "strong") return 0.4;
  return 0.3; // medium
}

function glowShadow(glowColor, spread) {
  const s = String(spread || "medium").toLowerCase();
  if (s === "tight") return `0 0 0 2px ${glowColor}`;
  if (s === "wide") return `0 0 0 2px ${glowColor}, 0 18px 45px -18px ${glowColor}`;
  return `0 0 0 2px ${glowColor}, 0 10px 25px -12px ${glowColor}`; // medium
}

function getPath(obj, path) {
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolveRefs(value, ctx) {
  if (typeof value !== "string") return value;
  const s = value.trim();
  const m = s.match(/^\{([a-zA-Z0-9_.]+)\}$/);
  if (!m) return value;
  const v = getPath(ctx, m[1]);
  return v === undefined ? value : v;
}

function computeDerived(editable) {
  const colors = editable?.colors || {};
  const buttons = editable?.buttons || {};

  const primary = colors.primary || "#2563eb";
  const accent = colors.accent || "#22c55e";
  const surface = colors.surface || "#0f172a";
  const border = colors.border || "#1f2937";

  const primaryTint = tint(primary, 0.35);
  const primaryShade = shade(primary, 0.18);
  const accentSoft = tint(accent, 0.55);
  const surfaceRaised = mix(surface, "#ffffff", 0.06);
  const borderSubtle = mix(border, surface, 0.35);

  const glowCfg = buttons?.glow || {};
  const glowSource = glowCfg.source === "accent" ? accent : primary;
  const gAlpha = glowAlpha(glowCfg.intensity);
  const glowColor = rgba(glowSource, gAlpha);
  const gShadow = glowShadow(glowColor, glowCfg.spread);

  // Status colors are fixed constants but soft/text/border are derived for consistency.
  const successSoft = tint("#22c55e", 0.85);
  const successText = shade("#22c55e", 0.35);
  const successBorder = tint("#22c55e", 0.65);
  const warningSoft = tint("#f59e0b", 0.85);
  const warningText = shade("#f59e0b", 0.35);
  const warningBorder = tint("#f59e0b", 0.65);
  const errorSoft = tint("#ef4444", 0.85);
  const errorText = shade("#ef4444", 0.35);
  const errorBorder = tint("#ef4444", 0.65);
  const infoSoft = tint("#3b82f6", 0.85);
  const infoText = shade("#3b82f6", 0.35);
  const infoBorder = tint("#3b82f6", 0.65);

  return {
    primaryTint,
    primaryShade,
    accentSoft,
    surfaceRaised,
    borderSubtle,
    glowColor,
    glowShadow: gShadow,
    successSoft,
    successText,
    successBorder,
    warningSoft,
    warningText,
    warningBorder,
    errorSoft,
    errorText,
    errorBorder,
    infoSoft,
    infoText,
    infoBorder,
  };
}

// Map schema -> CSS vars used across the app.
// Keep this minimal and extend safely over time.
function schemaToCssVars(schema) {
  const editable = schema?.editable || {};
  const derived = computeDerived(editable);
  const ctx = { colors: editable.colors || {}, derived, buttons: editable.buttons || {}, pills: editable.pills || {}, inputs: editable.inputs || {}, nav: editable.nav || {}, status: editable.status || {} };

  // Resolve top-level editable fields with {path} references.
  const primary = resolveRefs(editable?.colors?.primary, ctx);
  const accent = resolveRefs(editable?.colors?.accent, ctx);
  const background = resolveRefs(editable?.colors?.background, ctx);
  const surface = resolveRefs(editable?.colors?.surface, ctx);
  const text = resolveRefs(editable?.colors?.text, ctx);
  const mutedText = resolveRefs(editable?.colors?.mutedText, ctx);
  const border = resolveRefs(editable?.colors?.border, ctx);

  const pillBg = resolveRefs(editable?.pills?.bg, ctx);
  const pillText = resolveRefs(editable?.pills?.text, ctx);
  const pillHoverBg = resolveRefs(editable?.pills?.hoverBg, ctx);
  const pillActiveBg = resolveRefs(editable?.pills?.activeBg, ctx);
  const pillActiveText = resolveRefs(editable?.pills?.activeText, ctx);
  const pillBorder = resolveRefs(editable?.pills?.border, ctx);

  const btnPrimaryBg = resolveRefs(editable?.buttons?.primary?.bg, ctx);
  const btnPrimaryText = resolveRefs(editable?.buttons?.primary?.text, ctx);
  const btnActiveBg = resolveRefs(editable?.buttons?.active?.bg, ctx);
  const btnActiveText = resolveRefs(editable?.buttons?.active?.text, ctx);
  const focusRingColor = resolveRefs(editable?.buttons?.focus?.ringColor, ctx);

  // IMPORTANT:
  // The schema is published by writing a sanitized set of CSS vars into tenants.brand_overrides_json.
  // Therefore, we MUST output BookFlow's allowlisted "--bf-*" variables here (not raw canonical tokens).
  // Canonical tokens still exist in /app/tokens.css, but tenant overrides are applied via --bf-*.

  const inputBg = resolveRefs(editable?.inputs?.bg, ctx);
  const inputBorder = resolveRefs(editable?.inputs?.border, ctx);
  const focusRing = resolveRefs(editable?.buttons?.focus?.ringColor, ctx);

  const btnDisabledBg = resolveRefs(editable?.buttons?.primary?.disabledBg, ctx) ?? "#9ca3af";
  const btnDisabledText = resolveRefs(editable?.buttons?.primary?.disabledText, ctx) ?? String(mutedText);

  const css = {
    // Brand
    "--bf-brand-primary": String(primary),
    "--bf-brand-primary-dark": String(derived.primaryShade),
    "--bf-focus-ring": String(focusRing),

    // Page & typography
    "--bf-page-bg": String(background),
    "--bf-text-main": String(text),
    "--bf-text-muted": String(mutedText),
    // A softer helper text color (fallback to muted)
    "--bf-text-soft": String(mutedText),

    // Card
    "--bf-card-bg": String(surface),
    "--bf-card-border": String(border),

    // Controls / inputs
    "--bf-control-bg": String(inputBg),
    "--bf-control-border": String(inputBorder),

    // Pills
    "--bf-pill-bg": String(pillBg),
    "--bf-pill-border": String(pillBorder),
    "--bf-pill-text": String(pillText),
    "--bf-pill-selected-bg": String(pillActiveBg),
    "--bf-pill-selected-border": String(pillBorder),
    "--bf-pill-selected-text": String(pillActiveText),
    // Use computed glow math as the consistent selected shadow
    "--bf-pill-selected-shadow": String(derived.glowShadow),

    // Buttons (generic)
    "--bf-btn-bg": String(btnPrimaryBg),
    "--bf-btn-border": String(border),
    "--bf-btn-text": String(btnPrimaryText),
    "--bf-btn-bg-disabled": String(btnDisabledBg),
    "--bf-btn-text-disabled": String(btnDisabledText),

    // Semantic colors (map schema status -> BookFlow legacy semantics)
    // success
    "--bf-success": String(resolveRefs(editable?.status?.success?.text, ctx) ?? derived.successText),
    "--bf-success-bg": String(resolveRefs(editable?.status?.success?.bg, ctx) ?? derived.successSoft),
    "--bf-success-border": String(resolveRefs(editable?.status?.success?.border, ctx) ?? derived.successBorder),
    // error is used as "danger" in many components
    "--bf-danger": String(resolveRefs(editable?.status?.error?.text, ctx) ?? derived.errorText),
    "--bf-danger-bg": String(resolveRefs(editable?.status?.error?.bg, ctx) ?? derived.errorSoft),
    "--bf-danger-border": String(resolveRefs(editable?.status?.error?.border, ctx) ?? derived.errorBorder),

    // Back-compat aliases
    "--bf-text": String(text),
    "--bf-muted": String(mutedText),
    "--bf-surface": String(surface),
    "--bf-border": String(border),
  };

  // Sanitize to the existing allowlist contract, so we never write unsafe vars.
  const safe = {
    ...sanitizeBrandOverrides(css),
    ...sanitizeThemeTokens(css),
  };

  return { derived, cssVars: safe };
}

module.exports = {
  schemaToCssVars,
  // Export helpers for testing/diagnostics if needed
  _internals: { tint, shade, mix, rgba, glowAlpha, glowShadow },
};
