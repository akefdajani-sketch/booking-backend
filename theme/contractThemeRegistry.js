// theme/contractThemeRegistry.js
// ============================================================
// Phase 1.7-B (2026-05-10) — Backend Contract Theme Registry
// ============================================================
//
// Backend-side mirror of `lib/theme/themes/{classic,premium,minimal}.ts`
// from the frontend. This is **values-only duplication** — necessary because
// the snapshot publisher runs in Node and can't import TypeScript modules
// from the frontend repo.
//
// Drift policy:
//   When a theme value changes in the frontend (`lib/theme/themes/*.ts`),
//   the corresponding entry HERE must be updated in the same change. Tests
//   in the future will compare backend output to frontend output for a
//   set of fixture tenants and fail on drift.
//
// What's captured:
//   Three themes — `classic`, `premium`, `minimal` — covering 17/25 active
//   tenants today (premium 7, premium_v1 7 → premium, premium_v2 2 → premium,
//   classic 1). The remaining 8 (premium_light + 7 drafts) get null from
//   the contract publisher and the frontend gracefully falls back to legacy
//   `--bf-*` only.
//
// Color tokens are values that the publisher will OVERRIDE with brand-
// overrides-applied `--bf-*` resolved values (so Birdie's gold accent flows
// through `--bf-brand-primary` → `--color-accent`). These default values
// are the fallback when no `--bf-*` mapping exists for a contract token.
//
// Structural tokens (space, radius, font, shadow, motion, z, landing) do
// NOT receive brand overrides; they're emitted as-is from this registry.
//
// ============================================================

/* eslint-disable max-len */

// ── Shared canonical scales (identical across all 3 themes per Phase 1.1-1.3 capture) ──

const SHARED_SPACE = {
  "0": "0",
  "1": "4px",
  "2": "8px",
  "3": "12px",
  "4": "16px",
  "5": "20px",
  "6": "24px",
  "8": "32px",
  "10": "40px",
  "12": "48px",
  "16": "64px",
  "20": "80px",
  "24": "96px",
};

const SHARED_FONT_WEIGHT = {
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
};

const SHARED_LINE_HEIGHT = {
  tight: "1.1",
  snug: "1.2",
  normal: "1.5",
  relaxed: "1.625",
  loose: "1.75",
};

const SHARED_LETTER_SPACING = {
  tight: "-0.02em",
  normal: "0",
  wide: "0.02em",
};

const SHARED_MOTION = {
  fast: "150ms",
  base: "250ms",
  slow: "400ms",
  ease: "cubic-bezier(0.4, 0, 0.2, 1)",
  easeOut: "cubic-bezier(0, 0, 0.2, 1)",
  easeIn: "cubic-bezier(0.4, 0, 1, 1)",
  reducedMotion: false,
};

const SHARED_Z = {
  base: 0,
  raised: 10,
  sticky: 100,
  overlay: 1000,
  modal: 1100,
  toast: 1200,
  tooltip: 1300,
};

// ── Classic theme ──────────────────────────────────────────────────────────

const classicTheme = {
  key: "classic",
  name: "Classic",
  layout: "classic",
  allowsAccentOverride: false,
  recommendedFlowPreset: "date-first",

  color: {
    bg: "#f8fafc",
    bgSubtle: "#f1f5f9",
    surface: "#ffffff",
    surfaceRaised: "#ffffff",
    border: "#e2e8f0",
    borderStrong: "#cbd5e1",
    text: "#0f172a",
    textMuted: "#64748b",
    textInverse: "#ffffff",
    accent: "#4c8a3f",
    accentHover: "#3a6b31",
    accentText: "#ffffff",
    secondaryAccent: "#4c8a3f",
    secondaryAccentHover: "#3a6b31",
    secondaryAccentText: "#ffffff",
    success: "#22c55e",
    successText: "#ffffff",
    warning: "#f59e0b",
    warningText: "#0a0e1a",
    danger: "#ef4444",
    dangerText: "#ffffff",
    overlay: "rgba(15, 23, 42, 0.45)",
    focusRing: "rgba(37, 99, 235, 0.40)",
  },
  space: SHARED_SPACE,
  radius: { none: "0", sm: "6px", md: "10px", lg: "14px", xl: "18px", "2xl": "24px", pill: "999px" },
  font: {
    display: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    body: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  fontSize: {
    xs: "12px", sm: "13px", base: "14px", lg: "16px", xl: "18px",
    "2xl": "22px", "3xl": "28px", "4xl": "32px", "5xl": "40px", "6xl": "56px",
  },
  fontWeight: SHARED_FONT_WEIGHT,
  lineHeight: SHARED_LINE_HEIGHT,
  letterSpacing: SHARED_LETTER_SPACING,
  shadow: {
    none: "none",
    sm: "0 1px 2px rgba(15, 23, 42, 0.06)",
    md: "0 4px 12px rgba(15, 23, 42, 0.08)",
    lg: "0 10px 30px rgba(15, 23, 42, 0.10)",
    xl: "0 20px 50px rgba(15, 23, 42, 0.14)",
  },
  motion: SHARED_MOTION,
  z: SHARED_Z,
  landing: {
    density: "comfortable", heroVariant: "split", cardEmphasis: "subtle",
    sectionChrome: "soft", motionLevel: "subtle", dividerStyle: "solid", showPattern: false,
  },
};

// ── Premium theme ──────────────────────────────────────────────────────────

const premiumTheme = {
  key: "premium",
  name: "Premium",
  layout: "premium",
  allowsAccentOverride: false,
  recommendedFlowPreset: "date-first",

  color: {
    bg: "#020617",
    bgSubtle: "#0a0e1a",
    surface: "rgba(2, 6, 23, 0.38)",
    surfaceRaised: "rgba(2, 6, 23, 0.62)",
    border: "rgba(255, 255, 255, 0.12)",
    borderStrong: "rgba(255, 255, 255, 0.20)",
    text: "rgba(255, 255, 255, 0.92)",
    textMuted: "rgba(255, 255, 255, 0.72)",
    textInverse: "#0f172a",
    accent: "#22c55e",
    accentHover: "#129141",
    accentText: "rgba(255, 255, 255, 0.92)",
    secondaryAccent: "#22c55e",
    secondaryAccentHover: "#129141",
    secondaryAccentText: "rgba(255, 255, 255, 0.92)",
    success: "#22c55e",
    successText: "rgba(255, 255, 255, 0.92)",
    warning: "#f59e0b",
    warningText: "#0a0e1a",
    danger: "#fb7185",
    dangerText: "rgba(255, 255, 255, 0.92)",
    overlay: "rgba(0, 0, 0, 0.45)",
    focusRing: "rgba(34, 197, 94, 0.40)",
  },
  space: SHARED_SPACE,
  radius: { none: "0", sm: "8px", md: "12px", lg: "14px", xl: "20px", "2xl": "24px", pill: "999px" },
  font: {
    display: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    body: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  fontSize: {
    xs: "12px", sm: "14px", base: "16px", lg: "18px", xl: "22px",
    "2xl": "26px", "3xl": "32px", "4xl": "38px", "5xl": "48px", "6xl": "64px",
  },
  fontWeight: { normal: "400", medium: "500", semibold: "600", bold: "800" },
  lineHeight: SHARED_LINE_HEIGHT,
  letterSpacing: SHARED_LETTER_SPACING,
  shadow: {
    none: "none",
    sm: "0 2px 6px rgba(0, 0, 0, 0.18)",
    md: "0 8px 24px rgba(0, 0, 0, 0.28)",
    lg: "0 22px 70px rgba(0, 0, 0, 0.42)",
    xl: "0 32px 90px rgba(0, 0, 0, 0.50)",
  },
  motion: SHARED_MOTION,
  z: SHARED_Z,
  landing: {
    density: "comfortable", heroVariant: "immersive", cardEmphasis: "medium",
    sectionChrome: "glass", motionLevel: "expressive", dividerStyle: "gradient", showPattern: true,
  },
};

// ── Minimal theme ──────────────────────────────────────────────────────────

const minimalTheme = {
  key: "minimal",
  name: "Minimal",
  layout: "minimal",
  allowsAccentOverride: false,
  recommendedFlowPreset: "date-first",

  color: {
    bg: "#ffffff",
    bgSubtle: "#fafafa",
    surface: "#ffffff",
    surfaceRaised: "#ffffff",
    border: "rgba(15, 23, 42, 0.14)",
    borderStrong: "rgba(15, 23, 42, 0.22)",
    text: "#0f172a",
    textMuted: "rgba(15, 23, 42, 0.62)",
    textInverse: "#ffffff",
    accent: "#16a34a",
    accentHover: "#15803d",
    accentText: "rgba(255, 255, 255, 0.96)",
    secondaryAccent: "#16a34a",
    secondaryAccentHover: "#15803d",
    secondaryAccentText: "rgba(255, 255, 255, 0.96)",
    success: "#16a34a",
    successText: "rgba(255, 255, 255, 0.96)",
    warning: "#f59e0b",
    warningText: "#0a0e1a",
    danger: "#e11d48",
    dangerText: "#ffffff",
    overlay: "rgba(15, 23, 42, 0.25)",
    focusRing: "rgba(22, 163, 74, 0.40)",
  },
  space: SHARED_SPACE,
  radius: { none: "0", sm: "6px", md: "8px", lg: "12px", xl: "16px", "2xl": "20px", pill: "999px" },
  font: {
    display: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    body: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  fontSize: {
    xs: "11px", sm: "12px", base: "13px", lg: "15px", xl: "17px",
    "2xl": "20px", "3xl": "24px", "4xl": "30px", "5xl": "38px", "6xl": "52px",
  },
  fontWeight: SHARED_FONT_WEIGHT,
  lineHeight: SHARED_LINE_HEIGHT,
  letterSpacing: SHARED_LETTER_SPACING,
  shadow: {
    none: "none",
    sm: "0 1px 1px rgba(15, 23, 42, 0.04)",
    md: "0 2px 6px rgba(15, 23, 42, 0.06)",
    lg: "0 4px 14px rgba(15, 23, 42, 0.08)",
    xl: "0 10px 32px rgba(15, 23, 42, 0.12)",
  },
  motion: SHARED_MOTION,
  z: SHARED_Z,
  landing: {
    density: "compact", heroVariant: "compact", cardEmphasis: "subtle",
    sectionChrome: "flat", motionLevel: "subtle", dividerStyle: "solid", showPattern: false,
  },
};

// ── Registry exports ───────────────────────────────────────────────────────

const REGISTRY = {
  classic: classicTheme,
  premium: premiumTheme,
  minimal: minimalTheme,
};

/**
 * Mirror of frontend `lib/theme/isThemeFamily.ts`.
 * Strips `_v\d+$`, maps `default` → `classic`, `premiumlight` → `premium_light`.
 */
function normalizeThemeKey(key) {
  const raw = String(key || "").trim().toLowerCase();
  if (!raw) return "";
  const noVer = raw.replace(/_v\d+$/g, "");
  if (noVer === "default") return "classic";
  if (noVer === "premiumlight") return "premium_light";
  return noVer;
}

/**
 * Returns the contract theme value object for a tenant's theme_key, or null
 * if not in the Phase 1.1-1.3 registry (e.g., `premium_light`, `clinic`,
 * `modern` — to be added in Phase 3+).
 */
function getContractTheme(themeKey) {
  const normalized = normalizeThemeKey(themeKey);
  if (!normalized) return null;
  return REGISTRY[normalized] || null;
}

module.exports = {
  REGISTRY,
  normalizeThemeKey,
  getContractTheme,
};
