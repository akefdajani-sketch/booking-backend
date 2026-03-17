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
  return key === "premium" || key === "premium_v2" || layout === "premium";
}

function buildResolvedCssVars({ branding, brandOverrides, themeTokens, isPremium, isLightTheme }) {
  const colors = toObj(branding).colors || {};
  const themeVar = (key) => {
    const bv = brandOverrides && typeof brandOverrides[key] === "string" ? brandOverrides[key].trim() : "";
    if (bv) return bv;
    const tv = themeTokens && typeof themeTokens[key] === "string" ? themeTokens[key].trim() : "";
    if (tv) return tv;
    return "";
  };

  const premiumDark = !isLightTheme;
  const defaultPrimary = String(colors.primary || "#22c55e");
  const defaultPageBg = isPremium
    ? (premiumDark ? "#020617" : "#ffffff")
    : String(colors.background || "#f8fafc");
  const defaultSurface = isPremium
    ? (premiumDark ? "rgba(2, 6, 23, 0.38)" : "rgba(255,255,255,0.68)")
    : String(colors.surface || "#ffffff");
  const defaultBorder = isPremium
    ? (premiumDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.10)")
    : String(colors.border || "rgba(15,23,42,0.12)");
  const defaultText = isPremium
    ? (premiumDark ? "rgba(255,255,255,0.92)" : "rgba(15,23,42,0.92)")
    : String(colors.text || "rgba(15,23,42,0.92)");
  const defaultMuted = isPremium
    ? (premiumDark ? "rgba(255,255,255,0.72)" : "rgba(15,23,42,0.68)")
    : String(colors.mutedText || "rgba(15,23,42,0.68)");

  const primary = themeVar("--bf-brand-primary") || defaultPrimary;
  const primaryDark = themeVar("--bf-brand-primary-dark") || primary;
  const pageBg = themeVar("--bf-page-bg") || defaultPageBg;
  const surface = themeVar("--bf-surface") || themeVar("--bf-card-bg") || defaultSurface;
  const border = themeVar("--bf-border") || themeVar("--bf-card-border") || defaultBorder;
  const text = themeVar("--bf-text-main") || defaultText;
  const muted = themeVar("--bf-text-muted") || defaultMuted;
  const controlBg = themeVar("--bf-control-bg") || surface;
  const controlBorder = themeVar("--bf-control-border") || border;
  const menuBg = themeVar("--bf-menu-bg") || (isPremium ? (premiumDark ? "rgba(2,6,23,0.62)" : "rgba(255,255,255,0.72)") : surface);
  const drawerBg = themeVar("--bf-drawer-bg") || (isPremium ? (premiumDark ? "rgba(2,6,23,0.68)" : "rgba(255,255,255,0.78)") : surface);
  const drawerItemBg = themeVar("--bf-drawer-item-bg") || (isPremium ? (premiumDark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.44)") : surface);
  const drawerItemActiveBg = themeVar("--bf-drawer-item-bg-active") || (isPremium ? (premiumDark ? "rgba(34,197,94,0.22)" : "rgba(34,197,94,0.16)") : primary);
  const drawerItemText = themeVar("--bf-drawer-item-text") || text;
  const drawerItemTextActive = themeVar("--bf-drawer-item-text-active") || (premiumDark ? "#ffffff" : text);
  const glassBg = themeVar("--bf-glass-bg") || (isPremium ? (premiumDark ? "rgba(2,6,23,0.42)" : "rgba(255,255,255,0.26)") : surface);
  const glassStrongBg = themeVar("--bf-glass-bg-strong") || (isPremium ? (premiumDark ? "rgba(2,6,23,0.56)" : "rgba(255,255,255,0.38)") : surface);
  const glassBorder = themeVar("--bf-glass-border") || (isPremium ? (premiumDark ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.46)") : border);
  const glassShadow = themeVar("--bf-glass-shadow") || (isPremium ? (premiumDark ? "0 22px 70px rgba(2,6,23,0.30)" : "0 18px 42px rgba(15,23,42,0.12)") : "0 10px 30px rgba(15,23,42,0.12)");
  const glassHighlight = themeVar("--bf-glass-highlight") || (isPremium ? (premiumDark ? "linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.04) 100%)" : "linear-gradient(180deg, rgba(255,255,255,0.38) 0%, rgba(255,255,255,0.10) 100%)") : "none");
  const glassBlur = themeVar("--bf-glass-blur") || (isPremium ? (premiumDark ? "blur(18px)" : "blur(16px)") : "blur(0px)");
  const glassSaturate = themeVar("--bf-glass-saturate") || (isPremium ? (premiumDark ? "saturate(1.08)" : "saturate(1.10)") : "saturate(1)");

  const vars = {
    "--bf-brand-primary": primary,
    "--bf-brand-primary-dark": primaryDark,
    "--bf-page-bg": pageBg,
    "--bf-text-main": text,
    "--bf-text-muted": muted,
    "--bf-text-soft": themeVar("--bf-text-soft") || muted,
    "--bf-surface": surface,
    "--bf-border": border,
    "--bf-card-bg": themeVar("--bf-card-bg") || surface,
    "--bf-card-border": themeVar("--bf-card-border") || border,
    "--bf-control-bg": controlBg,
    "--bf-control-border": controlBorder,
    "--bf-control-text": themeVar("--bf-control-text") || text,
    "--bf-control-muted": themeVar("--bf-control-muted") || muted,
    "--bf-glass-bg": glassBg,
    "--bf-glass-bg-strong": glassStrongBg,
    "--bf-glass-border": glassBorder,
    "--bf-glass-shadow": glassShadow,
    "--bf-glass-highlight": glassHighlight,
    "--bf-glass-blur": glassBlur,
    "--bf-glass-saturate": glassSaturate,
    "--bf-menu-bg": menuBg,
    "--bf-menu-border": themeVar("--bf-menu-border") || glassBorder,
    "--bf-drawer-bg": drawerBg,
    "--bf-drawer-border": themeVar("--bf-drawer-border") || glassBorder,
    "--bf-drawer-item-bg": drawerItemBg,
    "--bf-drawer-item-bg-active": drawerItemActiveBg,
    "--bf-drawer-item-border": themeVar("--bf-drawer-item-border") || glassBorder,
    "--bf-drawer-item-text": drawerItemText,
    "--bf-drawer-item-text-active": drawerItemTextActive,
  };

  if (themeTokens && typeof themeTokens === "object") {
    for (const [k, v] of Object.entries(themeTokens)) if (typeof v === "string" && v.trim()) vars[k] = v;
  }
  if (brandOverrides && typeof brandOverrides === "object") {
    for (const [k, v] of Object.entries(brandOverrides)) if (typeof v === "string" && v.trim()) vars[k] = v;
  }
  return vars;
}

async function resolveTenantAppearanceSnapshot(tenantId) {
  const q = await db.query(`
    SELECT t.id, t.slug, t.theme_key,
           t.brand_overrides_json,
           t.branding,
           t.branding_published,
           t.publish_status,
           t.theme_schema_published_json,
           t.logo_url,
           t.cover_image_url,
           t.banner_home_url,
           t.banner_book_url,
           t.banner_account_url,
           t.banner_reservations_url,
           t.banner_memberships_url,
           pt.key AS platform_theme_key,
           pt.layout_key,
           pt.tokens_json
    FROM tenants t
    LEFT JOIN platform_themes pt ON pt.key = t.theme_key AND pt.is_published = TRUE
    WHERE t.id = $1
    LIMIT 1
  `, [tenantId]);
  const row = q.rows[0];
  if (!row) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const themeKey = String(row.theme_key || 'default_v1');
  const layoutKey = resolveLayoutKey(themeKey, row);
  const published = String(row.publish_status || '') === 'published';
  const branding = published ? toObj(row.branding_published) : {};
  const homeLanding =
    branding && typeof branding.homeLanding === "object"
      ? branding.homeLanding
      : {};
  const brandOverrides = toObj(row.brand_overrides_json);
  const publishedThemeSchema = toObj(row.theme_schema_published_json);
  const platformTokens = toObj(row.tokens_json);
  const premiumFamily = isPremiumFamily(themeKey, layoutKey);
  const isLightTheme = String(layoutKey).toLowerCase() === 'premium_light';

  const schemaResolved = publishedThemeSchema && typeof publishedThemeSchema === 'object'
    ? schemaToCssVars(publishedThemeSchema)
    : null;
  const schemaCssVars = isFlatCssVarMap(schemaResolved?.cssVars) ? schemaResolved.cssVars : {};
  const platformCssVars = isFlatCssVarMap(platformTokens) ? platformTokens : {};
  const themeStudioTokens = {
    ...platformCssVars,
    ...schemaCssVars,
  };
  const resolvedCssVars = buildResolvedCssVars({
    branding,
    brandOverrides,
    themeTokens: themeStudioTokens,
    isPremium: premiumFamily,
    isLightTheme,
  });

  const brandingAssets = toObj(branding.assets);
  const brandingBanners = toObj(brandingAssets.banners);
  const assets = {
    logoUrl: firstNonEmpty(brandingAssets.logoUrl, row.logo_url),
    heroImageUrl: firstNonEmpty(brandingAssets.heroImageUrl, brandingAssets.heroUrl),
    coverImageUrl: firstNonEmpty(brandingAssets.coverImageUrl, row.cover_image_url),
    membershipsImageUrl: firstNonEmpty(brandingAssets.membershipsImageUrl),
    packagesImageUrl: firstNonEmpty(brandingAssets.packagesImageUrl),
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
  debugSnapshotMarker: "plg2-assets-v1",
  isPremiumFamily: premiumFamily,
  isLightTheme,
  branding,
  brandOverrides,
  themeStudioTokens,
  resolvedCssVars,
  landing: {
    showPattern: premiumFamily,
    patternStyle: premiumFamily ? 'premium-grid-subtle' : 'none',
    templateKey: homeLanding && typeof homeLanding === 'object' && typeof homeLanding.templateKey === 'string' && homeLanding.templateKey.trim()
      ? homeLanding.templateKey.trim()
      : 'default',
    templateVersion: Number.isFinite(Number(homeLanding?.version)) ? Number(homeLanding.version) : 1,
  },
  homeLanding,
  assets,
  publishedAt: new Date().toISOString(),
  };
}

async function writeTenantAppearanceSnapshot(tenantId) {
  const snapshot = await resolveTenantAppearanceSnapshot(tenantId);
  await db.query(`
    UPDATE tenants
       SET appearance_snapshot_published_json = $2::jsonb,
           appearance_snapshot_published_at = NOW(),
           appearance_snapshot_version = COALESCE(appearance_snapshot_version, 0) + 1,
           appearance_snapshot_source_theme_key = $3,
           appearance_snapshot_layout_key = $4
     WHERE id = $1
  `, [tenantId, JSON.stringify(snapshot), snapshot.themeKey, snapshot.layoutKey]);
  return snapshot;
}

module.exports = { resolveTenantAppearanceSnapshot, writeTenantAppearanceSnapshot };
