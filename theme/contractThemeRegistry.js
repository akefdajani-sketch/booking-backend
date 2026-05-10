// theme/contractThemeRegistry.js
// ============================================================
// Backend Contract Theme Registry — Phase 3.3 superset (2026-05-10)
// ============================================================
//
// Backend-side mirror of `lib/theme/themes/*.ts` from the frontend.
// This is **values-only duplication** — necessary because the snapshot
// publisher runs in Node and can't import TypeScript modules from the
// frontend repo.
//
// Layered patches reflected:
//   1.7-B — classic + premium + minimal added (Phase 1 baseline)
//   3.1   — premium-hospitality added
//   3.3   — boutique-beauty added (this superset)
//
// Drift policy:
//   When a theme value changes in the frontend (`lib/theme/themes/*.ts`),
//   the corresponding entry HERE must be updated in the same change. Tests
//   in the future will compare backend output to frontend output for a
//   set of fixture tenants and fail on drift.
//
// What's captured:
//   Five themes — `classic`, `premium`, `minimal`, `premium-hospitality`,
//   `boutique-beauty`.
//   Phase 1.7-B covered the first three (17/25 active tenants).
//   Phase 3.1 added premium-hospitality (Birdie migrated in 3.2).
//   Phase 3.3 adds boutique-beauty, dormant until Phase 3.4 creates
//   Studio Nur as the Malaysia GTM demo tenant. The remaining 4 THEMES-V2
//   themes (calm-clinical, marketplace-listings, artisan-kitchen,
//   modern-minimal) ship in Phase 4. premium_light and draft tenants
//   continue getting null from the contract publisher and the frontend
//   gracefully falls back to legacy `--bf-*` only.
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

// ── Premium Hospitality theme (Phase 3.1) ──────────────────────────────────
//
// Anchor: Birdie Golf (post Phase 3.2 migration).
// Vertical: golf clubs, hotels, high-end venues.
// Mood: immersive, refined, confident, photo-led, hospitable.
//
// Color tokens here are DEFAULTS — the publisher overrides them with the
// tenant's brand_overrides_applied --bf-* values (Birdie's gold flows
// through --bf-brand-primary → --color-accent). The defaults below render
// for tenants on this theme who don't have brand overrides set.
//
// NOTE: this theme inlines `lineHeight` and `letterSpacing` rather than
// using SHARED_LINE_HEIGHT/SHARED_LETTER_SPACING because the spec values
// (lineHeight.tight 1.15, letterSpacing.tight -0.01em) diverge from the
// SHARED constants (1.1, -0.02em). Pre-existing FE/BE drift on classic/
// premium/minimal is not propagated forward into new themes — for
// premium-hospitality the FE and BE values match exactly.

const premiumHospitalityTheme = {
  key: "premium-hospitality",
  name: "Premium Hospitality",
  layout: "premium",
  allowsAccentOverride: false,
  recommendedFlowPreset: "date-first",

  color: {
    bg: "#0A0E1A",
    bgSubtle: "#11172A",
    surface: "#1A2138",
    surfaceRaised: "#1A2138",
    border: "#243049",
    borderStrong: "#3A4868",
    text: "#F5F1E8",
    textMuted: "#A8B0C2",
    textInverse: "#0A0E1A",
    accent: "#C9A961",
    accentHover: "#D4B872",
    accentText: "#0A0E1A",
    secondaryAccent: "#C9A961",
    secondaryAccentHover: "#D4B872",
    secondaryAccentText: "#0A0E1A",
    success: "#6B9F71",
    successText: "#F5F1E8",
    warning: "#D4A547",
    warningText: "#0A0E1A",
    danger: "#C25B5B",
    dangerText: "#F5F1E8",
    overlay: "rgba(10, 14, 26, 0.75)",
    focusRing: "#C9A961",
  },
  space: SHARED_SPACE,
  radius: { none: "0", sm: "4px", md: "8px", lg: "12px", xl: "16px", "2xl": "24px", pill: "9999px" },
  font: {
    display: "\"Cormorant Garamond\", \"Lora\", Georgia, serif",
    body: "Inter, \"DM Sans\", -apple-system, BlinkMacSystemFont, sans-serif",
    mono: "\"JetBrains Mono\", \"SF Mono\", Consolas, monospace",
  },
  fontSize: {
    xs: "12px", sm: "14px", base: "16px", lg: "18px", xl: "20px",
    "2xl": "24px", "3xl": "30px", "4xl": "36px", "5xl": "48px", "6xl": "60px",
  },
  fontWeight: SHARED_FONT_WEIGHT,
  // Spec-exact lineHeight (diverges from SHARED — see header note).
  lineHeight: {
    tight: "1.15",
    snug: "1.2",
    normal: "1.55",
    relaxed: "1.625",
    loose: "1.75",
  },
  // Spec-exact letterSpacing (diverges from SHARED — see header note).
  letterSpacing: {
    tight: "-0.01em",
    normal: "0",
    wide: "0.02em",
  },
  shadow: {
    none: "none",
    sm: "0 1px 2px rgba(0, 0, 0, 0.3)",
    md: "0 4px 8px rgba(0, 0, 0, 0.35)",
    lg: "0 8px 24px rgba(0, 0, 0, 0.4)",
    xl: "0 16px 48px rgba(0, 0, 0, 0.5)",
  },
  motion: SHARED_MOTION,  // happens to match spec exactly (150/250/400)
  z: SHARED_Z,
  landing: {
    density: "comfortable", heroVariant: "immersive", cardEmphasis: "medium",
    sectionChrome: "soft", motionLevel: "subtle", dividerStyle: "gradient", showPattern: false,
  },
};

// ── Boutique Beauty theme (Phase 3.3) ──────────────────────────────────────
//
// Anchor: Studio Nur (Malaysia GTM demo, created in Phase 3.4 — dormant
// until then).
// Vertical: beauty salons, spas, Muslimah studios, nail/brow/lash, hair,
// mehndi, esthetics — taste-driven personal services.
// Mood: polished, warm, modern, considered, versatile (Muslimah-compatible).
//
// Color tokens here are DEFAULTS — the publisher overrides them with the
// tenant's brand_overrides_applied --bf-* values when a tenant uses
// brand_overrides. Different from premium-hospitality:
// `allowsAccentOverride: true` — tenants on this theme are encouraged to
// supply their own accent (per spec §Risks: mauve-burgundy may read as too
// dark for younger Muslimah demographic).
//
// LIGHT THEME — first contract-pipeline light theme. Shadow base is
// rgba(44, 36, 32, ...) (charcoal-brown text color) NOT rgba(0, 0, 0, ...)
// to keep card edges warm-toned on the cream surface.
//
// NOTE: this theme inlines `lineHeight` rather than using SHARED_LINE_HEIGHT
// because the spec value (lineHeight.normal 1.6) diverges from SHARED (1.5)
// for editorial breathing room. `letterSpacing` matches SHARED so we use it.

const boutiqueBeautyTheme = {
  key: "boutique-beauty",
  name: "Boutique Beauty",
  layout: "premium",
  allowsAccentOverride: true,
  recommendedFlowPreset: "service-first",

  color: {
    bg: "#FAF6F1",
    bgSubtle: "#F2EBE2",
    surface: "#FFFFFF",
    surfaceRaised: "#FFFFFF",
    border: "#E8DDD0",
    borderStrong: "#C4A99D",
    text: "#2C2420",
    textMuted: "#7A6A5F",
    textInverse: "#FAF6F1",
    accent: "#7B3F4F",
    accentHover: "#8E4A5C",
    accentText: "#FAF6F1",
    secondaryAccent: "#7B3F4F",
    secondaryAccentHover: "#8E4A5C",
    secondaryAccentText: "#FAF6F1",
    success: "#7A8A5A",
    successText: "#FAF6F1",
    warning: "#C9954C",
    warningText: "#2C2420",
    danger: "#A04A4A",
    dangerText: "#FAF6F1",
    overlay: "rgba(44, 36, 32, 0.55)",
    focusRing: "#7B3F4F",
  },
  space: SHARED_SPACE,
  radius: { none: "0", sm: "4px", md: "8px", lg: "12px", xl: "16px", "2xl": "24px", pill: "9999px" },
  font: {
    display: "\"Playfair Display\", \"Cormorant Garamond\", Georgia, serif",
    body: "Inter, \"DM Sans\", -apple-system, BlinkMacSystemFont, sans-serif",
    mono: "\"JetBrains Mono\", \"SF Mono\", Consolas, monospace",
  },
  fontSize: {
    xs: "12px", sm: "14px", base: "16px", lg: "18px", xl: "20px",
    "2xl": "24px", "3xl": "30px", "4xl": "36px", "5xl": "48px", "6xl": "60px",
  },
  fontWeight: SHARED_FONT_WEIGHT,
  // Spec-exact lineHeight: normal=1.6 (vs SHARED 1.5) — boutique editorial.
  lineHeight: {
    tight: "1.1",
    snug: "1.2",
    normal: "1.6",
    relaxed: "1.625",
    loose: "1.75",
  },
  // letterSpacing matches SHARED exactly (tight: -0.02em, normal: 0, wide: 0.02em).
  letterSpacing: SHARED_LETTER_SPACING,
  // LIGHT-theme shadows — charcoal-brown rgba base, NOT rgba(0,0,0).
  shadow: {
    none: "none",
    sm: "0 1px 2px rgba(44, 36, 32, 0.05)",
    md: "0 4px 12px rgba(44, 36, 32, 0.08)",
    lg: "0 10px 30px rgba(44, 36, 32, 0.10)",
    xl: "0 24px 70px rgba(44, 36, 32, 0.18)",
  },
  motion: SHARED_MOTION,
  z: SHARED_Z,
  landing: {
    density: "comfortable", heroVariant: "split", cardEmphasis: "medium",
    sectionChrome: "soft", motionLevel: "subtle", dividerStyle: "gradient", showPattern: false,
  },
};

// ── Registry exports ───────────────────────────────────────────────────────

const REGISTRY = {
  classic: classicTheme,
  premium: premiumTheme,
  minimal: minimalTheme,
  "premium-hospitality": premiumHospitalityTheme,
  "boutique-beauty": boutiqueBeautyTheme,
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
