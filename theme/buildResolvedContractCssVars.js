// theme/buildResolvedContractCssVars.js
// ============================================================
// Phase 1.7-B (2026-05-10) — Contract CSS Var Builder
// ============================================================
//
// Pure function that takes:
//   - themeKey       — the resolved tenant theme key (e.g., "premium_v1")
//   - resolvedCssVars — the already-built `--bf-*` map (with brand_overrides
//                       already applied by `buildResolvedCssVars()`)
//
// And returns a flat record of canonical contract CSS vars
// (`--color-*`, `--space-*`, `--radius-*`, `--font-*`, `--shadow-*`,
// `--motion-*`, `--z-*`, `--landing-*`) suitable for storing in the
// snapshot blob alongside `resolvedCssVars`.
//
// ── Key design ─────────────────────────────────────────────────────────────
//
// Color tokens are sourced FROM the already-resolved `--bf-*` map (which
// carries brand_overrides). This means `--color-accent` = Birdie's gold
// (`rgba(24, 74, 58, 0.88)`) automatically, because the legacy publisher
// already resolved `--bf-brand-primary` against `tenants.brand_overrides_json`.
//
// Structural tokens (space, radius, font, shadow, motion, z, landing) are
// emitted from theme registry defaults — they don't receive brand overrides.
//
// Returns null when themeKey is not in the contract registry — frontend
// falls back to legacy `--bf-*` only (no behavioral change for those tenants).
//
// ── Mirror of frontend `themeToContractCssVars()` ──────────────────────────
//
// Output var names are byte-identical to frontend's
// `lib/theme/publishContractTokens.ts:themeToContractCssVars()`. Any naming
// drift is a P0 bug — the frontend `ContractThemeProvider` reads these.
//
// ============================================================

const { getContractTheme } = require("./contractThemeRegistry");

/**
 * Color-token sources from `--bf-*` resolved vars.
 * Keys = contract token names (without `--color-` prefix);
 * values = the `--bf-*` var to read from.
 *
 * For tokens with no `--bf-*` equivalent (e.g., `bg-subtle`, `border-strong`,
 * `text-inverse`, `secondary-accent-*`, `*-text` for status, `focus-ring`),
 * the theme default is used.
 */
const COLOR_BF_SOURCES = {
  bg: "--bf-page-bg",
  surface: "--bf-card-bg",
  border: "--bf-border",
  text: "--bf-text-main",
  textMuted: "--bf-text-muted",
  accent: "--bf-brand-primary",
  accentHover: "--bf-brand-primary-dark",
  accentText: "--bf-btn-text",
  success: "--bf-success",
  warning: "--bf-warn",
  danger: "--bf-danger",
  overlay: "--bf-modal-backdrop",
};

function pickColor(token, theme, bfVars) {
  const bfKey = COLOR_BF_SOURCES[token];
  if (bfKey && bfVars && typeof bfVars[bfKey] === "string" && bfVars[bfKey].trim()) {
    return bfVars[bfKey];
  }
  return theme.color[token];
}

/**
 * Build the canonical contract CSS var bag for a tenant.
 *
 * @param {object} input
 * @param {string} input.themeKey - Tenant theme_key (raw — will be normalized).
 * @param {Record<string,string>} [input.resolvedCssVars] - Already-built --bf-* map
 *   (output of buildResolvedCssVars). Color tokens are sourced from this.
 * @returns {Record<string,string> | null} Contract var map, or null if theme
 *   not in registry.
 */
function buildResolvedContractCssVars({ themeKey, resolvedCssVars }) {
  const theme = getContractTheme(themeKey);
  if (!theme) return null;

  const bfVars =
    resolvedCssVars && typeof resolvedCssVars === "object" ? resolvedCssVars : {};
  const vars = {};

  // ── Color (brand-overrides flow via --bf-* sources) ────────────────────
  vars["--color-bg"] = pickColor("bg", theme, bfVars);
  vars["--color-bg-subtle"] = theme.color.bgSubtle;
  vars["--color-surface"] = pickColor("surface", theme, bfVars);
  vars["--color-surface-raised"] = theme.color.surfaceRaised;
  vars["--color-border"] = pickColor("border", theme, bfVars);
  vars["--color-border-strong"] = theme.color.borderStrong;
  vars["--color-text"] = pickColor("text", theme, bfVars);
  vars["--color-text-muted"] = pickColor("textMuted", theme, bfVars);
  vars["--color-text-inverse"] = theme.color.textInverse;
  vars["--color-accent"] = pickColor("accent", theme, bfVars);
  vars["--color-accent-hover"] = pickColor("accentHover", theme, bfVars);
  vars["--color-accent-text"] = pickColor("accentText", theme, bfVars);
  // Per OQ-2: themes without secondary copy primary into secondary.
  // We mirror the (potentially-overridden) primary to stay consistent.
  vars["--color-secondary-accent"] = vars["--color-accent"];
  vars["--color-secondary-accent-hover"] = vars["--color-accent-hover"];
  vars["--color-secondary-accent-text"] = vars["--color-accent-text"];
  vars["--color-success"] = pickColor("success", theme, bfVars);
  vars["--color-success-text"] = theme.color.successText;
  vars["--color-warning"] = pickColor("warning", theme, bfVars);
  vars["--color-warning-text"] = theme.color.warningText;
  vars["--color-danger"] = pickColor("danger", theme, bfVars);
  vars["--color-danger-text"] = theme.color.dangerText;
  vars["--color-overlay"] = pickColor("overlay", theme, bfVars);
  vars["--color-focus-ring"] = theme.color.focusRing;

  // ── Space (no overrides) ───────────────────────────────────────────────
  for (const [k, v] of Object.entries(theme.space)) {
    vars[`--space-${k}`] = v;
  }

  // ── Radius (no overrides) ──────────────────────────────────────────────
  for (const [k, v] of Object.entries(theme.radius)) {
    vars[`--radius-${k}`] = v;
  }

  // ── Font families ──────────────────────────────────────────────────────
  vars["--font-display"] = theme.font.display;
  vars["--font-body"] = theme.font.body;
  vars["--font-mono"] = theme.font.mono;

  // ── Font sizes ─────────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(theme.fontSize)) {
    vars[`--font-size-${k}`] = v;
  }

  // ── Font weights ───────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(theme.fontWeight)) {
    vars[`--font-weight-${k}`] = v;
  }

  // ── Line heights ───────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(theme.lineHeight)) {
    vars[`--line-height-${k}`] = v;
  }

  // ── Letter spacing ─────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(theme.letterSpacing)) {
    vars[`--letter-spacing-${k}`] = v;
  }

  // ── Shadows ────────────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(theme.shadow)) {
    vars[`--shadow-${k}`] = v;
  }

  // ── Motion ─────────────────────────────────────────────────────────────
  vars["--motion-fast"] = theme.motion.fast;
  vars["--motion-base"] = theme.motion.base;
  vars["--motion-slow"] = theme.motion.slow;
  vars["--easing-ease"] = theme.motion.ease;
  vars["--easing-ease-out"] = theme.motion.easeOut;
  vars["--easing-ease-in"] = theme.motion.easeIn;

  // ── Z-index ────────────────────────────────────────────────────────────
  vars["--z-base"] = String(theme.z.base);
  vars["--z-raised"] = String(theme.z.raised);
  vars["--z-sticky"] = String(theme.z.sticky);
  vars["--z-overlay"] = String(theme.z.overlay);
  vars["--z-modal"] = String(theme.z.modal);
  vars["--z-toast"] = String(theme.z.toast);
  vars["--z-tooltip"] = String(theme.z.tooltip);

  // ── Landing variants ───────────────────────────────────────────────────
  vars["--landing-density"] = theme.landing.density;
  vars["--landing-hero-variant"] = theme.landing.heroVariant;
  vars["--landing-card-emphasis"] = theme.landing.cardEmphasis;
  vars["--landing-section-chrome"] = theme.landing.sectionChrome;
  vars["--landing-motion-level"] = theme.landing.motionLevel;
  vars["--landing-divider-style"] = theme.landing.dividerStyle;
  vars["--landing-show-pattern"] = theme.landing.showPattern ? "1" : "0";

  return vars;
}

module.exports = { buildResolvedContractCssVars };
