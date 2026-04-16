const db = require("../db");
const { schemaToCssVars } = require("./resolveThemeSchema");

function toObj(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function resolveLayoutKey(themeKey, themeRow) {
  const raw = String(themeRow?.layout_key || themeKey || "classic").trim().toLowerCase();
  if (!raw) return "classic";
  if (raw === "default_v1" || raw === "default") return "classic";
  if (raw === "premium_v2") return "premium";
  if (raw === "premiumlight") return "premium_light";
  return raw;
}

function isFlatCssVarMap(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (!keys.length) return false;
  return keys.every((k) => typeof k === "string" && k.startsWith("--bf-"));
}

function isPremiumFamily(themeKey, layoutKey) {
  const key = String(themeKey || "").toLowerCase();
  const layout = String(layoutKey || "").toLowerCase();
  return (
    key === "premium" || key === "premium_v2" ||
    layout === "premium" || layout === "premium_v2"
  );
}

// ---------------------------------------------------------------------------
// Color math helpers (mirrors computeTenantCssVars.ts)
// ---------------------------------------------------------------------------
function parseCssColorToRgb(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let raw = hex[1];
    if (raw.length === 3) raw = raw.split("").map((ch) => ch + ch).join("");
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
    ];
  }
  const rgb = v.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(",").map((p) => p.trim());
    if (parts.length >= 3) {
      const nums = parts.slice(0, 3).map((p) => parseFloat(p));
      if (nums.every((n) => isFinite(n))) {
        return nums.map((n) => Math.max(0, Math.min(255, Math.round(n))));
      }
    }
  }
  return null;
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((ch) => {
    const n = ch / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isLightSurface(value) {
  const rgb = parseCssColorToRgb(value);
  if (!rgb) return false;
  return relativeLuminance(rgb) >= 0.58;
}

function rgbaFromRgb(rgb, alpha, fallback) {
  if (!rgb) return fallback;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function extractVarFallback(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v.startsWith("var(")) return null;
  const comma = v.indexOf(",");
  if (comma === -1) return null;
  const end = v.lastIndexOf(")");
  if (end === -1 || end <= comma) return null;
  return v.slice(comma + 1, end).trim() || null;
}

// ---------------------------------------------------------------------------
// Full CSS var computation.
// Mirrors computeTenantCssVars.ts exactly so SSR snapshot and client compute
// identical values — eliminating the first-paint flash and per-tab flicker.
// ---------------------------------------------------------------------------
function buildResolvedCssVars({ branding, brandOverrides, themeTokens, isPremium, isLightTheme, preservePremiumGlass = false }) {
  const colors = toObj(branding).colors || {};
  const typography = toObj(branding).typography || {};
  const buttons = toObj(branding).buttons || {};
  const bookingUi = toObj(branding).bookingUi || {};

  // Brand primary -------------------------------------------------------
  const defaultPrimary = String(colors.primary || "#22c55e");
  const overridePrimary =
    brandOverrides && typeof brandOverrides["--bf-brand-primary"] === "string"
      ? brandOverrides["--bf-brand-primary"].trim()
      : "";
  const overridePrimaryDark =
    brandOverrides && typeof brandOverrides["--bf-brand-primary-dark"] === "string"
      ? brandOverrides["--bf-brand-primary-dark"].trim()
      : "";

  const primary = overridePrimary || defaultPrimary;
  const primaryDark =
    overridePrimaryDark ||
    `color-mix(in srgb, ${primary} 70%, black)`;

  // Page & card bg -------------------------------------------------------
  const premiumDark = isPremium && !isLightTheme;

  // For premium themes, allow Brand Setup "Background" and "Card surface" to
  // override the computed defaults. Guard: only accept a surface value whose
  // luminance matches the theme direction — prevents a stale light-green test
  // value (#cdfcca) from overriding a dark premium theme's glass base colour.
  //   premiumDark  → accept only dark surfaces  (luminance < 0.18)
  //   premiumLight → accept only light surfaces (luminance > 0.55)
  const _rawSurface = String(colors.surface || "").trim();
  const _rawBg      = String(colors.background || "").trim();
  const _surfRgb    = _rawSurface ? parseCssColorToRgb(_rawSurface) : null;
  const _surfLum    = _surfRgb ? relativeLuminance(_surfRgb) : null;

  const defaultPageBg = isPremium
    ? (_rawBg || (premiumDark ? "#020617" : "#ffffff"))
    : String(colors.background || "#f8fafc");
  const defaultCardBg = isPremium
    ? (premiumDark
        ? (preservePremiumGlass
            ? "rgba(2, 6, 23, 0.38)"
            : (_surfLum !== null && _surfLum < 0.18 ? _rawSurface : "rgba(2, 6, 23, 0.38)"))
        : (_surfLum !== null && _surfLum > 0.55 ? _rawSurface : "rgba(255,255,255,0.68)"))
    : String(colors.surface || "#ffffff");
  const defaultBorder = isPremium
    ? (String(colors.border || "").trim() || (premiumDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.10)"))
    : String(colors.border || "rgba(15,23,42,0.12)");
  const defaultText = isPremium
    ? premiumDark ? "rgba(255,255,255,0.92)" : "rgba(15,23,42,0.92)"
    : String(colors.text || "rgba(15,23,42,0.92)");
  const defaultMuted = isPremium
    ? premiumDark ? "rgba(255,255,255,0.72)" : "rgba(15,23,42,0.68)"
    : String(colors.mutedText || "rgba(15,23,42,0.68)");

  // Helper: resolve a token from brandOverrides > themeTokens > fallback
  const themeVar = (key, fallback = "") => {
    const bv =
      brandOverrides && typeof brandOverrides[key] === "string"
        ? brandOverrides[key].trim()
        : "";
    if (bv) return bv;
    const tv =
      themeTokens && typeof themeTokens[key] === "string"
        ? themeTokens[key].trim()
        : "";
    return tv || fallback;
  };

  const pageBg = themeVar("--bf-page-bg", defaultPageBg) || defaultPageBg;
  const cardBgRaw = themeVar("--bf-card-bg", defaultCardBg) || defaultCardBg;
  const cardBg = extractVarFallback(cardBgRaw) || cardBgRaw;
  const cardBorder = themeVar("--bf-card-border", defaultBorder) || defaultBorder;
  const cardBgRgb = parseCssColorToRgb(cardBg);
  const pageBgRgb = parseCssColorToRgb(pageBg);
  const lightSurface = isLightSurface(cardBg);

  // Typography -----------------------------------------------------------
  const fontFamilyKey = String(typography.fontFamily || "system");
  const headingWeightRaw = typeof typography.headingWeight === "number" ? typography.headingWeight : null;
  const bodyWeightRaw = typeof typography.bodyWeight === "number" ? typography.bodyWeight : null;

  const fontFamily =
    fontFamilyKey === "inter"
      ? "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
      : fontFamilyKey === "serif"
        ? 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif'
        : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

  const headingWeight = headingWeightRaw == null ? 700 : clamp(headingWeightRaw, 100, 900);
  const bodyWeight = bodyWeightRaw == null ? 400 : clamp(bodyWeightRaw, 100, 900);

  // Radius ---------------------------------------------------------------
  const btnRadiusRaw = typeof buttons.radius === "number" ? buttons.radius : 14;
  const btnRadius = clamp(btnRadiusRaw, 0, 30);

  // Density vars (mirrors computeTenantCssVars.ts densityVars) -----------
  const density = bookingUi.density === "compact" ? "compact" : "comfortable";
  const densityVars =
    density === "compact"
      ? {
          "--bf-card-pad": "12px",
          "--bf-card-mt": "6px",
          "--bf-card-mb": "12px",
          "--bf-pill-h": "30px",
          "--bf-pill-fs": "12px",
          "--bf-pill-px": "10px",
        }
      : {
          "--bf-card-pad": "16px",
          "--bf-card-mt": "8px",
          "--bf-card-mb": "16px",
          "--bf-pill-h": "34px",
          "--bf-pill-fs": "13px",
          "--bf-pill-px": "12px",
        };

  // Glass vars (same luminance-based algorithm as the frontend) ----------
  const glassBaseFallback = lightSurface
    ? `color-mix(in srgb, ${cardBg} 82%, rgba(255,255,255,0.18) 18%)`
    : rgbaFromRgb(cardBgRgb || pageBgRgb, 0.42, "rgba(2,6,23,0.42)");
  const glassStrongFallback = lightSurface
    ? `color-mix(in srgb, ${cardBg} 88%, rgba(255,255,255,0.12) 12%)`
    : rgbaFromRgb(cardBgRgb || pageBgRgb, 0.56, "rgba(2,6,23,0.56)");
  const glassBg = lightSurface
    ? `color-mix(in srgb, ${glassBaseFallback} 96%, ${primary} 4%)`
    : `color-mix(in srgb, ${glassBaseFallback} 86%, ${primary} 14%)`;
  const glassStrongBg = lightSurface
    ? `color-mix(in srgb, ${glassStrongFallback} 97%, ${primary} 3%)`
    : `color-mix(in srgb, ${glassStrongFallback} 90%, ${primary} 10%)`;
  const glassBorder = lightSurface
    ? `color-mix(in srgb, ${cardBorder} 76%, rgba(255,255,255,0.30) 24%)`
    : `color-mix(in srgb, ${cardBorder} 74%, rgba(255,255,255,0.18) 26%)`;
  const glassShadow = lightSurface
    ? "0 22px 56px rgba(15,23,42,0.14)"
    : "0 22px 70px rgba(2,6,23,0.30)";
  const glassHighlight = lightSurface
    ? "linear-gradient(180deg, rgba(255,255,255,0.26), rgba(255,255,255,0.12) 24%, rgba(255,255,255,0.04) 56%, rgba(255,255,255,0.00) 100%)"
    : "linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.04) 100%)";
  const glassBlur = lightSurface ? "blur(20px)" : "blur(18px)";

  // Premium pattern vars -------------------------------------------------
  const premiumPatternLine = lightSurface ? "rgba(15,23,42,0.070)" : "rgba(255,255,255,0.05)";
  const premiumPatternOpacity = lightSurface ? "0.15" : "0.22";
  const premiumPatternSize = lightSurface ? "28px" : "26px";
  const premiumPatternSheenOpacity = lightSurface ? "0.64" : "0.92";
  const premiumLightGridOpacity = lightSurface ? "0.15" : "0";
  const premiumPatternBlend = lightSurface ? "multiply" : "soft-light";

  // Menu / drawer --------------------------------------------------------
  const menuGlassBg = glassStrongBg;
  const drawerGlassBg = lightSurface
    ? `color-mix(in srgb, ${glassStrongBg} 94%, rgba(255,255,255,0.14) 6%)`
    : `color-mix(in srgb, ${glassStrongBg} 94%, rgba(2,6,23,0.18) 6%)`;
  const drawerItemBg = lightSurface
    ? "color-mix(in srgb, rgba(255,255,255,0.44) 100%, transparent)"
    : `color-mix(in srgb, ${glassBg} 82%, transparent)`;
  const drawerItemActiveBg = lightSurface
    ? `color-mix(in srgb, ${primary} 16%, rgba(255,255,255,0.84) 84%)`
    : `color-mix(in srgb, ${primary} 24%, ${glassStrongBg} 76%)`;
  const drawerItemText = extractVarFallback(defaultText) || defaultText;
  const drawerItemTextActive = lightSurface ? drawerItemText : "#ffffff";

  // Pill selected --------------------------------------------------------
  const pillSelectedBg = `color-mix(in srgb, ${primary} 18%, transparent)`;
  const pillSelectedBorder = primaryDark;
  const pillSelectedText = lightSurface ? defaultText : "#ffffff";
  const pillSelectedShadow =
    `0 0 0 3px color-mix(in srgb, ${primary} 22%, transparent), ` +
    `0 10px 26px color-mix(in srgb, ${primary} 16%, transparent)`;

  // Text selection -------------------------------------------------------
  const selectionBg = `color-mix(in srgb, ${primary} 40%, ${primaryDark} 60%)`;

  // Semantic -------------------------------------------------------------
  const successBg = `color-mix(in srgb, ${primary} 22%, transparent)`;

  // Controls -------------------------------------------------------------
  const controlBg = themeVar("--bf-control-bg", cardBg) || cardBg;
  const controlBorder = themeVar("--bf-control-border", cardBorder) || cardBorder;
  const controlFocusBorder = themeVar("--bf-control-focus-border", "#719af2") || "#719af2";

  // Nav / pill hover (static defaults; tenants override via brand_overrides)
  const navHoverBg = "#1d2537";
  const navActiveBg = "#1e51c1";
  const navActiveText = "#ffffff";

  // -----------------------------------------------------------------------
  // Full var map — identical key set to computeTenantCssVars.ts
  // -----------------------------------------------------------------------
  const vars = {
    // Brand
    "--bf-brand-primary": primary,
    "--bf-brand-primary-dark": primaryDark,

    // Page & typography
    "--bf-font-family": fontFamily,
    "--bf-font-weight-heading": String(headingWeight),
    "--bf-font-weight-body": String(bodyWeight),
    "--bf-page-bg": pageBg,
    "--bf-text-main": defaultText,
    "--bf-text-muted": defaultMuted,
    "--bf-text-soft": defaultMuted,

    // Base semantics
    "--bf-surface": cardBg,
    "--bf-border": cardBorder,

    // Text selection highlight
    "--bf-selection-bg": selectionBg,
    "--bf-selection-text": "#ffffff",

    // Card
    "--bf-card-bg": cardBg,
    "--bf-card-border": cardBorder,
    "--bf-card-shadow": themeVar("--bf-card-shadow", "0 10px 30px rgba(15,23,42,0.08)"),

    // Glass
    "--bf-glass-bg": glassBg,
    "--bf-glass-bg-strong": glassStrongBg,
    "--bf-glass-border": glassBorder,
    "--bf-glass-shadow": glassShadow,
    "--bf-glass-highlight": glassHighlight,
    "--bf-glass-blur": glassBlur,
    "--bf-glass-saturate": "saturate(1.08)",
    "--bf-glass-menu-blur": "blur(12px)",

    // Premium pattern
    "--bf-premium-pattern-line": premiumPatternLine,
    "--bf-premium-pattern-opacity": premiumPatternOpacity,
    "--bf-premium-pattern-size": premiumPatternSize,
    "--bf-premium-pattern-sheen-opacity": premiumPatternSheenOpacity,
    "--bf-premium-light-grid-opacity": premiumLightGridOpacity,
    "--bf-premium-pattern-blend": premiumPatternBlend,

    // Controls
    "--bf-control-bg": controlBg,
    "--bf-control-border": controlBorder,
    "--bf-control-text": defaultText,
    "--bf-control-muted": defaultMuted,
    "--bf-control-focus-border": controlFocusBorder,

    // Page shell defaults
    "--bf-page-hero-pad-top": "16px",
    "--bf-page-pad-x": "12px",
    "--bf-page-content-pad-top": "12px",
    "--bf-page-pad-bottom": "96px",
    "--bf-page-max-w": "1100px",

    // Menu / drawer
    "--bf-menu-bg": menuGlassBg,
    "--bf-menu-border": glassBorder,
    "--bf-drawer-bg": drawerGlassBg,
    "--bf-drawer-border": glassBorder,
    "--bf-drawer-item-bg": drawerItemBg,
    "--bf-drawer-item-bg-active": drawerItemActiveBg,
    "--bf-drawer-item-border": glassBorder,
    "--bf-drawer-item-text": drawerItemText,
    "--bf-drawer-item-text-active": drawerItemTextActive,

    // Radius
    "--bf-btn-radius": `${btnRadius}px`,
    "--bf-pill-radius": `${btnRadius}px`,

    // Pills
    "--bf-pill-bg": cardBg,
    "--bf-pill-border": primaryDark,
    "--bf-pill-text": defaultText,
    "--bf-pill-selected-bg": pillSelectedBg,
    "--bf-pill-selected-border": pillSelectedBorder,
    "--bf-pill-selected-text": pillSelectedText,
    "--bf-pill-selected-shadow": pillSelectedShadow,
    "--bf-pill-hover-bg": navHoverBg,

    // Buttons
    "--bf-btn-bg": primary,
    "--bf-btn-text": "#ffffff",
    "--bf-btn-bg-disabled": "#9ca3af",
    "--bf-btn-text-disabled": defaultMuted,
    "--bf-btn-active-bg": navActiveBg,
    "--bf-btn-active-text": "#ffffff",
    "--bf-btn-secondary-bg": navHoverBg,
    "--bf-btn-ghost-hover-bg": navHoverBg,

    // Nav
    "--bf-nav-hover-bg": navHoverBg,
    "--bf-nav-active-bg": navActiveBg,
    "--bf-nav-active-text": navActiveText,

    // Semantic status
    "--bf-danger": "#b91c1c",
    "--bf-danger-bg": "#fee2e2",
    "--bf-danger-border": "#f97373",
    "--bf-success": primaryDark,
    "--bf-success-bg": successBg,
    "--bf-success-border": primary,
    "--bf-info-bg": "#e2ecfe",
    "--bf-info-border": "#bad3fc",
    "--bf-warning-bg": "#fef0da",
    "--bf-warning-border": "#fcddaa",
    "--bf-hero-text": "#f9fafb",

    // Back-compat aliases
    "--bf-text": defaultText,
    "--bf-muted": defaultMuted,

    // Density-driven layout vars
    ...densityVars,

    // Bottom nav - computed from brand primary so active state matches brand
    "--bf-bottomnav-bg": lightSurface
      ? "color-mix(in srgb, var(--bf-page-bg, #ffffff) 88%, transparent)"
      : "color-mix(in srgb, var(--bf-page-bg, #020617) 82%, transparent)",
    "--bf-bottomnav-active-bg": `color-mix(in srgb, ${primary} 12%, transparent)`,
    "--bf-bottomnav-active-border": `color-mix(in srgb, ${primary} 30%, transparent)`,
    "--bf-bottomnav-active-text": primary,

    // Outline / ghost button — computed from brand primary
    "--bf-btn-outline-bg": "transparent",
    "--bf-btn-outline-border": `color-mix(in srgb, ${primary} 45%, transparent)`,
    "--bf-btn-outline-text": primary,
    "--bf-btn-border": cardBorder,

    // Semantic warn (alias for warning)
    "--bf-warn": "#92400e",
    "--bf-warn-bg": "#fef3c7",
    "--bf-warn-border": "#fde68a",

    // Link color
    "--bf-link": primary,

    // Primary contrast (text on primary bg — for accessible button labels)
    "--bf-primary": primary,
    "--bf-primary-contrast": lightSurface ? "#0f172a" : "#ffffff",
  };

  // Apply theme studio tokens. The BLOCKED set mirrors BLOCKED_THEME_TOKEN_KEYS
  // in computeTenantCssVars.ts — platform themes must not override brand semantics.
  const BLOCKED = new Set([
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

  if (themeTokens && typeof themeTokens === "object") {
    for (const [k, v] of Object.entries(themeTokens)) {
      if (BLOCKED.has(k)) continue;
      if (typeof v === "string" && v.trim()) vars[k] = v;
    }
  }

  // Brand overrides always win; empty strings are skipped (same guardrail as frontend)
  if (brandOverrides && typeof brandOverrides === "object") {
    for (const [k, v] of Object.entries(brandOverrides)) {
      if (typeof v !== "string" || !v.trim()) continue;
      vars[k] = v;
    }
  }

  return vars;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function resolveTenantAppearanceSnapshot(tenantId) {
  const q = await db.query(
    `SELECT t.id, t.slug, t.theme_key,
            t.brand_overrides_json,
            t.branding,
            t.branding_published,
            t.branding_published_at,
            t.publish_status,
            t.theme_schema_published_json,
            t.logo_url,
            t.cover_image_url,
            t.banner_home_url,
            t.banner_book_url,
            t.banner_account_url,
            t.banner_reservations_url,
            t.banner_memberships_url,
            pt.key   AS platform_theme_key,
            pt.layout_key,
            pt.tokens_json
     FROM tenants t
     LEFT JOIN platform_themes pt
            ON pt.key = t.theme_key AND pt.is_published = TRUE
     WHERE t.id = $1
     LIMIT 1`,
    [tenantId]
  );
  const row = q.rows[0];
  if (!row) {
    const err = new Error("Tenant not found");
    err.status = 404;
    throw err;
  }

  const themeKey = String(row.theme_key || "default_v1");
  const layoutKey = resolveLayoutKey(themeKey, row);
  const published = String(row.publish_status || "") === "published";
  const branding = published ? toObj(row.branding_published) : {};
  const homeLanding =
    branding && typeof branding.homeLanding === "object" ? branding.homeLanding : {};
  // brandOverrides: merge brand_overrides_json (legacy) with branding.brand_overrides
  // (set by the "Premium glass controls" and "Theme Studio" UI).
  // branding.brand_overrides wins so intentional glass/drawer overrides take effect.
  // This is what makes the glass controls panel actually influence the booking page.
  const _legacyOverrides = toObj(row.brand_overrides_json);
  const _brandingOverrides = toObj(branding.brand_overrides);
  const brandOverrides = { ..._legacyOverrides, ..._brandingOverrides };
  const publishedThemeSchema = toObj(row.theme_schema_published_json);
  const platformTokens = toObj(row.tokens_json);
  const premiumFamily = isPremiumFamily(themeKey, layoutKey);
  const isLightTheme = String(layoutKey).toLowerCase() === "premium_light";

  const schemaResolved =
    publishedThemeSchema && typeof publishedThemeSchema === "object"
      ? schemaToCssVars(publishedThemeSchema)
      : null;
  const schemaCssVars = isFlatCssVarMap(schemaResolved?.cssVars) ? schemaResolved.cssVars : {};
  const platformCssVars = isFlatCssVarMap(platformTokens) ? platformTokens : {};
  const themeStudioTokens = { ...platformCssVars, ...schemaCssVars };

  const resolvedCssVars = buildResolvedCssVars({
    branding,
    brandOverrides,
    themeTokens: themeStudioTokens,
    isPremium: premiumFamily,
    isLightTheme,
    preservePremiumGlass: String(themeKey).toLowerCase() === "premium_v2",
  });

  const brandingAssets = toObj(branding.assets);
  const brandingBanners = toObj(brandingAssets.banners);
  const assets = {
    logoUrl: firstNonEmpty(brandingAssets.logoUrl, row.logo_url),
    heroImageUrl: firstNonEmpty(brandingAssets.heroImageUrl, brandingAssets.heroUrl),
    coverImageUrl: firstNonEmpty(brandingAssets.coverImageUrl, row.cover_image_url),
    membershipsImageUrl: firstNonEmpty(brandingAssets.membershipsImageUrl),
    packagesImageUrl: firstNonEmpty(brandingAssets.packagesImageUrl),
    // Logo sizing — saved by the Images tab, must be in snapshot so
    // the public page can read them without waiting for a client fetch.
    logoHeroSize:   firstNonEmpty(brandingAssets.logoHeroSize,   brandingAssets.logoSize) || null,
    logoDrawerSize: firstNonEmpty(brandingAssets.logoDrawerSize, brandingAssets.logoSize) || null,
    logoPosition:   firstNonEmpty(brandingAssets.logoPosition) || null,
    banners: {
      home: firstNonEmpty(brandingBanners.home, row.banner_home_url),
      book: firstNonEmpty(brandingBanners.book, row.banner_book_url),
      account: firstNonEmpty(brandingBanners.account, row.banner_account_url),
      reservations: firstNonEmpty(brandingBanners.reservations, row.banner_reservations_url),
      memberships: firstNonEmpty(brandingBanners.memberships, row.banner_memberships_url),
      packages: firstNonEmpty(brandingBanners.packages),
    },
  };

  return {
    themeKey,
    layoutKey,
    presetVersion: 1,
    // Bump marker version so the frontend can detect old snapshots during rollout
    debugSnapshotMarker: "plg2-assets-v3",
    isPremiumFamily: premiumFamily,
    isLightTheme,
    branding,
    brandOverrides,
    themeStudioTokens,
    resolvedCssVars,
    landing: {
      showPattern: premiumFamily,
      patternStyle: premiumFamily ? "premium-grid-subtle" : "none",
      templateKey:
        homeLanding &&
        typeof homeLanding === "object" &&
        typeof homeLanding.templateKey === "string" &&
        homeLanding.templateKey.trim()
          ? homeLanding.templateKey.trim()
          : "default",
      templateVersion: Number.isFinite(Number(homeLanding?.version))
        ? Number(homeLanding.version)
        : 1,
    },
    homeLanding,
    assets,
    publishedAt: new Date().toISOString(),
  };
}

async function writeTenantAppearanceSnapshot(tenantId) {
  const snapshot = await resolveTenantAppearanceSnapshot(tenantId);
  await db.query(
    `UPDATE tenants
        SET appearance_snapshot_published_json = $2::jsonb,
            appearance_snapshot_published_at   = NOW(),
            appearance_snapshot_version        = COALESCE(appearance_snapshot_version, 0) + 1,
            appearance_snapshot_source_theme_key = $3,
            appearance_snapshot_layout_key     = $4
      WHERE id = $1`,
    [tenantId, JSON.stringify(snapshot), snapshot.themeKey, snapshot.layoutKey]
  );
  return snapshot;
}

module.exports = { resolveTenantAppearanceSnapshot, writeTenantAppearanceSnapshot };
