// scripts/themes_v2/_lib.js
// ─────────────────────────────────────────────────────────────────────────
// Shared helpers for the Phase 5.1 theme-sync scripts.
//
// Imported by:
//   01_audit_theme_sync.js
//   02_apply_theme_sync.js
//   02b_publish_theme_sync.js
//
// Anything that reads contractThemeRegistry, mirrors the resolver's
// snapshot composition, normalizes CSS values, or diffs CSS var maps
// lives here so the three scripts produce byte-identical outcomes.

"use strict";

const { REGISTRY: CONTRACT_REGISTRY } = require("../../theme/contractThemeRegistry");
const {
  buildResolvedCssVars,
  resolveLayoutKey,
  isPremiumFamily,
  toObj,
  isFlatCssVarMap,
} = require("../../theme/resolveTenantAppearanceSnapshot");
const { schemaToCssVars } = require("../../theme/resolveThemeSchema");

// ── Constants ────────────────────────────────────────────────────────────

// Phase 5.1 hardcodes premium-hospitality out — Birdie hold pending greenlight.
const REJECTED_KEYS = ["premium-hospitality"];

// Mirrors COLOR_BF_SOURCES in theme/buildResolvedContractCssVars.js, INVERTED:
// publisher reads bf→contract; we synthesize contract→bf for tokens_json material.
const COLOR_BF_SOURCES = {
  bg: "--bf-page-bg",
  surface: "--bf-card-bg",                 // BLOCKED in resolver (no-op for resolved output)
  border: "--bf-border",                   // BLOCKED
  text: "--bf-text-main",
  textMuted: "--bf-text-muted",
  accent: "--bf-brand-primary",            // BLOCKED
  accentHover: "--bf-brand-primary-dark",  // BLOCKED
  accentText: "--bf-btn-text",
  success: "--bf-success",                 // BLOCKED
  warning: "--bf-warn",
  danger: "--bf-danger",
  overlay: "--bf-modal-backdrop",
};

// Mirrors BLOCKED set in theme/resolveTenantAppearanceSnapshot.js:475-485.
const BLOCKED_BF_KEYS = new Set([
  "--bf-brand-primary", "--bf-brand-primary-dark",
  "--bf-surface", "--bf-border",
  "--bf-card-bg", "--bf-card-border",
  "--bf-control-bg", "--bf-control-border", "--bf-control-text", "--bf-control-muted",
  "--bf-menu-bg", "--bf-menu-border",
  "--bf-drawer-bg", "--bf-drawer-border",
  "--bf-pill-selected-bg", "--bf-pill-selected-border",
  "--bf-pill-selected-shadow", "--bf-pill-selected-text",
  "--bf-success", "--bf-success-bg", "--bf-success-border",
]);

// ── Candidate row from contract registry ─────────────────────────────────
function buildCandidateRow(themeKey) {
  const theme = CONTRACT_REGISTRY[themeKey];
  if (!theme) return null;
  const tokens_json = {};
  for (const [src, dst] of Object.entries(COLOR_BF_SOURCES)) {
    const val = theme.color && theme.color[src];
    if (typeof val === "string" && val.trim()) tokens_json[dst] = val;
  }
  return {
    key: themeKey,
    name: theme.name,
    layout_key: theme.layout,
    tokens_json,
  };
}

// ── Snapshot composition (mirrors resolveTenantAppearanceSnapshot ~541-574) ─
//
// platformTokensOverride semantics:
//   undefined → use tenantRow.platform_tokens_json (current state from JOIN)
//   null      → simulate "no row visible to resolver" (e.g. unpublished)
//   object    → simulate "this exact tokens_json is the joined row"
function composeResolvedCssVars(tenantRow, platformTokensOverride) {
  const themeKey = String(tenantRow.theme_key || "default_v1");
  const fakeThemeRow = { layout_key: tenantRow.platform_theme_layout_key || null };
  const layoutKey = resolveLayoutKey(themeKey, fakeThemeRow);
  const published = String(tenantRow.publish_status || "") === "published";
  const branding = published ? toObj(tenantRow.branding_published) : {};
  const _legacyOverrides = toObj(tenantRow.brand_overrides_json);
  const _brandingOverrides = toObj(branding.brand_overrides);
  const brandOverrides = { ..._legacyOverrides, ..._brandingOverrides };
  const publishedThemeSchema = toObj(tenantRow.theme_schema_published_json);

  const platformTokens =
    platformTokensOverride === undefined
      ? toObj(tenantRow.platform_tokens_json)
      : toObj(platformTokensOverride);

  const premiumFamily = isPremiumFamily(themeKey, layoutKey);
  const lightTheme = String(layoutKey).toLowerCase() === "premium_light";

  const schemaResolved =
    publishedThemeSchema && typeof publishedThemeSchema === "object"
      ? schemaToCssVars(publishedThemeSchema)
      : null;
  const schemaCssVars = isFlatCssVarMap(schemaResolved && schemaResolved.cssVars)
    ? schemaResolved.cssVars
    : {};
  const platformCssVars = isFlatCssVarMap(platformTokens) ? platformTokens : {};
  const themeStudioTokens = { ...platformCssVars, ...schemaCssVars };

  return buildResolvedCssVars({
    branding,
    brandOverrides,
    themeTokens: themeStudioTokens,
    isPremium: premiumFamily,
    isLightTheme: lightTheme,
    preservePremiumGlass: String(themeKey).toLowerCase() === "premium_v2",
  });
}

// ── CSS value normalization ──────────────────────────────────────────────
//
// rgb()/rgba() → canonical "rgb(r, g, b)" / "rgba(r, g, b, a)" with single
//   spaces; rgba(...,1) collapses to rgb(...).
// hex          → lowercase, 3-char expanded to 6-char.
// other        → trim + collapse internal whitespace.
//
// Diff output should always REPORT original values, not normalized forms.
function normalizeCssValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v !== "string") return String(v);
  const s = v.trim();
  if (!s) return s;

  const hex3 = s.match(/^#([0-9a-fA-F]{3})$/);
  if (hex3) {
    return "#" + hex3[1].toLowerCase().split("").map((ch) => ch + ch).join("");
  }
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();

  const rgbMatch = s.match(/^rgba?\s*\(\s*([^)]+)\s*\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((p) => p.trim());
    if (parts.length === 3 || parts.length === 4) {
      const r = parseInt(parts[0], 10);
      const g = parseInt(parts[1], 10);
      const b = parseInt(parts[2], 10);
      if ([r, g, b].every((n) => Number.isFinite(n))) {
        if (parts.length === 3) return `rgb(${r}, ${g}, ${b})`;
        const a = parseFloat(parts[3]);
        if (Number.isFinite(a)) {
          if (a === 1) return `rgb(${r}, ${g}, ${b})`;
          return `rgba(${r}, ${g}, ${b}, ${a})`;
        }
      }
    }
  }

  return s.replace(/\s+/g, " ");
}

// ── Diff helper ──────────────────────────────────────────────────────────
function diffMaps(current, simulated) {
  const diffs = [];
  const keys = new Set([
    ...Object.keys(current || {}),
    ...Object.keys(simulated || {}),
  ]);
  for (const k of keys) {
    const cv = current ? current[k] : undefined;
    const sv = simulated ? simulated[k] : undefined;
    const cn = normalizeCssValue(cv);
    const sn = normalizeCssValue(sv);
    if (cn === sn) continue;
    diffs.push({
      key: k,
      current: cv === undefined ? null : cv,
      simulated: sv === undefined ? null : sv,
      addition: (cv === undefined || cv === null) && sv !== undefined && sv !== null,
      blocked: BLOCKED_BF_KEYS.has(k),
    });
  }
  return diffs;
}

// ── tokens_json equality (idempotency check for Script 2) ────────────────
function tokensEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (a[ak[i]] !== b[bk[i]]) return false;
  }
  return true;
}

module.exports = {
  CONTRACT_REGISTRY,
  REJECTED_KEYS,
  COLOR_BF_SOURCES,
  BLOCKED_BF_KEYS,
  buildCandidateRow,
  composeResolvedCssVars,
  normalizeCssValue,
  diffMaps,
  tokensEqual,
};
