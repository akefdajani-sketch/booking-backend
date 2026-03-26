const express = require("express");
const router = express.Router();
const db = require("../db");
const { resolveTenantAppearanceSnapshot } = require("../theme/resolveTenantAppearanceSnapshot");

// Schema-compat: public endpoints must not crash if a newer optional column
// doesn't exist yet in an environment.
let __tenantColCache = null;
async function hasTenantColumn(col) {
  if (!__tenantColCache) {
    try {
      const r = await db.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tenants'
          AND column_name = ANY($1::text[])
        `,
        [["default_phone_country_code", "appearance_snapshot_published_json", "appearance_snapshot_version", "appearance_snapshot_published_at", "cover_image_url"]]
      );
      __tenantColCache = new Set(r.rows.map((x) => x.column_name));
    } catch {
      __tenantColCache = new Set();
    }
  }
  return __tenantColCache.has(col);
}

// Current canonical snapshot marker written by resolveTenantAppearanceSnapshot.
// Bump this string whenever buildResolvedCssVars changes its output shape OR
// whenever resolveLayoutKey logic changes, so stale snapshots are auto-invalidated.
const CURRENT_SNAPSHOT_MARKER = "plg2-assets-v3";

// Resolve what layoutKey SHOULD be for this tenant given its theme_key and the
// resolved platform_themes row. Mirrors resolveLayoutKey in resolveTenantAppearanceSnapshot.
// Used to detect snapshots baked with a wrong layoutKey (e.g. premium_light for a
// premium_v2 tenant) without needing to re-JOIN platform_themes in this route.
function expectedIsLightTheme(themeKey, resolvedLayoutKey) {
  const layout = String(resolvedLayoutKey || themeKey || "").trim().toLowerCase();
  return layout === "premium_light";
}

function snapshotNeedsRefresh(snapshot, tenant, resolvedLayoutKey) {
  if (!snapshot || typeof snapshot !== "object") return true;

  const sourceTheme = String(snapshot.themeKey || "").trim().toLowerCase();
  const tenantTheme = String(tenant.theme_key || "").trim().toLowerCase();

  // 1) Theme key mismatch — snapshot was built for a different theme
  if (!sourceTheme || sourceTheme !== tenantTheme) return true;

  // 2) Marker version mismatch — snapshot predates the current var set
  if (snapshot.debugSnapshotMarker !== CURRENT_SNAPSHOT_MARKER) return true;

  // 3) Layout key / isLightTheme consistency check.
  //    This catches snapshots baked with the wrong layout key (e.g. a premium_v2
  //    tenant whose snapshot says layoutKey="premium_light" and isLightTheme=true).
  //    Those snapshots produce white glass cards instead of dark glass.
  if (resolvedLayoutKey) {
    const expectedLight = expectedIsLightTheme(tenantTheme, resolvedLayoutKey);
    const snapshotLight = Boolean(snapshot.isLightTheme);
    if (expectedLight !== snapshotLight) return true;

    // Also check the layoutKey itself matches
    const snapshotLayout = String(snapshot.layoutKey || "").trim().toLowerCase();
    const expectedLayout = String(resolvedLayoutKey || "").trim().toLowerCase();
    if (snapshotLayout && expectedLayout && snapshotLayout !== expectedLayout) return true;
  }

  // 4) Premium families need the full glass/menu/drawer core to be present
  const cssVars =
    snapshot.resolvedCssVars && typeof snapshot.resolvedCssVars === "object"
      ? snapshot.resolvedCssVars
      : null;
  const hasPremiumCore = !!(
    cssVars &&
    cssVars["--bf-page-bg"] &&
    cssVars["--bf-card-bg"] &&
    cssVars["--bf-glass-bg"] &&
    cssVars["--bf-menu-bg"] &&
    cssVars["--bf-drawer-bg"] &&
    cssVars["--bf-font-family"] &&
    cssVars["--bf-pill-selected-shadow"]
  );
  if (
    (tenantTheme === "premium" ||
      tenantTheme === "premium_v2" ||
      resolvedLayoutKey === "premium") &&
    !hasPremiumCore
  )
    return true;

  // 5) Branding was published more recently than the snapshot
  //    (catches color/brand changes that bypass writeTenantAppearanceSnapshot)
  const snapshotAt = snapshot.publishedAt ? new Date(snapshot.publishedAt).getTime() : 0;
  const brandingAt = tenant.branding_published_at
    ? new Date(tenant.branding_published_at).getTime()
    : 0;
  if (brandingAt && snapshotAt && brandingAt > snapshotAt) return true;

  return false;
}

// Public, cacheable tenant appearance payload for /book/[slug]
//
// IMPORTANT:
// - Only returns *published* branding + *published* theme schema.
// - Draft values are admin-only.
router.get("/:slug", async (req, res) => {
  const { slug } = req.params;

  const defaultPhoneSel = (await hasTenantColumn("default_phone_country_code"))
    ? "default_phone_country_code"
    : "NULL::text AS default_phone_country_code";

  const t = await db.query(
    `SELECT id, slug, theme_key, brand_overrides_json,
            branding,
            branding_published,
            publish_status,
            theme_schema_published_json,
            ${defaultPhoneSel},
            appearance_snapshot_published_json,
            appearance_snapshot_version,
            appearance_snapshot_published_at,
            banner_home_url, banner_book_url, banner_account_url, banner_reservations_url, banner_memberships_url,
            logo_url, cover_image_url,
            branding_published_at
     FROM tenants
     WHERE slug = $1`,
    [slug]
  );

  if (!t.rows[0]) return res.status(404).json({ error: "Tenant not found" });

  const tenant = t.rows[0];
  const themeKey = tenant.theme_key || "default_v1";

  // Built-in theme keys that ship with the frontend layouts.
  // These must work even if `platform_themes` rows haven't been seeded yet.
  const BUILTIN_THEME_KEYS = new Set(["default_v1", "classic", "premium", "premium_v2", "premium_light"]);

  let theme = null;

  // 1) If it's a builtin theme, prefer DB row if published, otherwise fall back to builtin.
  if (BUILTIN_THEME_KEYS.has(themeKey)) {
    const th = await db.query(
      "SELECT key, tokens_json, layout_key FROM platform_themes WHERE key = $1 AND is_published = TRUE LIMIT 1",
      [themeKey]
    );
    theme = th.rows[0] || { key: themeKey, tokens_json: {}, layout_key: themeKey === "default_v1" ? "classic" : themeKey };
  } else {
    // 2) Non-builtin themes MUST exist and be published (SaaS-grade).
    const th = await db.query(
      "SELECT key, tokens_json, layout_key FROM platform_themes WHERE key = $1 AND is_published = TRUE LIMIT 1",
      [themeKey]
    );
    if (th.rows[0]) theme = th.rows[0];
  }

  // Final fallback: default_v1 if nothing else exists.
  if (!theme) {
    const th = await db.query(
      "SELECT key, tokens_json, layout_key FROM platform_themes WHERE key = 'default_v1' AND is_published = TRUE LIMIT 1"
    );
    theme = th.rows[0] || { key: "default_v1", tokens_json: {}, layout_key: "classic" };
  }

  // IMPORTANT:
  // Banner images are updated frequently during setup and should reflect immediately
  // on the public booking pages. Avoid caching this payload.
  res.set("Cache-Control", "no-store");

  // Phase 1.5: Lock down public contract (published-only)
  // Public endpoints must NEVER leak draft/working snapshots.
  // If a tenant is not published (or published snapshot is empty), return branding=null.
  const publishedObj = tenant.branding_published && typeof tenant.branding_published === "object"
    ? tenant.branding_published
    : null;
  const publishedAssets = publishedObj && typeof publishedObj.assets === 'object' ? publishedObj.assets : {};
  const publishedAssetBanners = publishedAssets && typeof publishedAssets.banners === 'object' ? publishedAssets.banners : {};
  const hasPublished = publishedObj && Object.keys(publishedObj).length > 0;
  const isPublished = String(tenant.publish_status || "") === "published";
  const effectiveBranding = (isPublished && hasPublished) ? publishedObj : null;

  // Always overlay the latest banner URLs onto the effective branding.
  // Tenants can keep a published branding snapshot for tokens, but still expect
  // banner uploads (stored on the tenant row) to show right away.
  const tenantBanners = {
    home: tenant.banner_home_url || publishedAssetBanners.home || null,
    book: tenant.banner_book_url || publishedAssetBanners.book || null,
    account: tenant.banner_account_url || publishedAssetBanners.account || null,
    reservations: tenant.banner_reservations_url || publishedAssetBanners.reservations || null,
    memberships: tenant.banner_memberships_url || publishedAssetBanners.memberships || null,
    packages: publishedAssetBanners.packages || null,
  };

  // Focal point settings live in the draft branding JSONB (image_settings).
  // They are always served from the live branding row (not just published),
  // because focal point edits should show immediately — same as banner URL uploads.
  const draftBranding = tenant.branding && typeof tenant.branding === "object" ? tenant.branding : {};
  const tenantImageSettings = draftBranding.image_settings && typeof draftBranding.image_settings === "object"
    ? draftBranding.image_settings
    : {};

  const effectiveBrandingWithBanners = effectiveBranding
    ? {
        ...effectiveBranding,
        assets: {
          ...(effectiveBranding.assets || {}),
          logoUrl: (effectiveBranding.assets && effectiveBranding.assets.logoUrl) || tenant.logo_url || null,
          coverImageUrl: (effectiveBranding.assets && effectiveBranding.assets.coverImageUrl) || tenant.cover_image_url || null,
          banners: {
            ...((effectiveBranding.assets && effectiveBranding.assets.banners) || {}),
            ...tenantBanners,
          },
        },
        // Always overlay live focal point settings so they update without a publish step.
        image_settings: {
          ...(effectiveBranding.image_settings || {}),
          ...tenantImageSettings,
        },
      }
    : null;

  // Theme schema is served as the *published* snapshot only.
  // If tenant isn't published yet, this must be null.
  const publishedThemeSchema = tenant.theme_schema_published_json && typeof tenant.theme_schema_published_json === "object"
    ? tenant.theme_schema_published_json
    : null;
  const effectiveThemeSchema = isPublished ? publishedThemeSchema : null;

  // Resolve the canonical layoutKey from the platform_themes row — this is
  // what the snapshot SHOULD have. Passed to snapshotNeedsRefresh so it can
  // detect snapshots baked with the wrong layout (e.g. premium_light for a
  // premium_v2 tenant).
  const resolvedLayoutKey = (() => {
    const raw = String(theme.layout_key || themeKey || "classic").trim().toLowerCase();
    if (!raw || raw === "default_v1" || raw === "default") return "classic";
    if (raw === "premium_v2") return "premium";
    if (raw === "premiumlight") return "premium_light";
    return raw;
  })();

  let appearanceSnapshot = tenant.appearance_snapshot_published_json && typeof tenant.appearance_snapshot_published_json === "object"
    ? tenant.appearance_snapshot_published_json
    : null;
  let snapshotUsed = !!appearanceSnapshot;
  if (isPublished && snapshotNeedsRefresh(appearanceSnapshot, tenant, resolvedLayoutKey)) {
    try {
      appearanceSnapshot = await resolveTenantAppearanceSnapshot(tenant.id);
    } catch {
      appearanceSnapshot = appearanceSnapshot && typeof appearanceSnapshot === "object" ? appearanceSnapshot : null;
    }
    snapshotUsed = false;
  }

  if (appearanceSnapshot && typeof appearanceSnapshot === "object") {
    const snapshotAssets = appearanceSnapshot.assets && typeof appearanceSnapshot.assets === "object"
      ? appearanceSnapshot.assets
      : {};
    const snapshotBanners = snapshotAssets.banners && typeof snapshotAssets.banners === "object"
      ? snapshotAssets.banners
      : {};

    const snapshotBranding =
      appearanceSnapshot.branding && typeof appearanceSnapshot.branding === "object"
        ? appearanceSnapshot.branding
        : {};

    const snapshotHomeLanding =
      appearanceSnapshot.homeLanding && typeof appearanceSnapshot.homeLanding === "object"
        ? appearanceSnapshot.homeLanding
        : snapshotBranding.homeLanding && typeof snapshotBranding.homeLanding === "object"
        ? snapshotBranding.homeLanding
        : null;

    appearanceSnapshot = {
      ...appearanceSnapshot,
      homeLanding: snapshotHomeLanding,
      branding: {
        ...snapshotBranding,
        ...(snapshotHomeLanding ? { homeLanding: snapshotHomeLanding } : {}),
      },
      assets: {
        ...snapshotAssets,
        logoUrl: snapshotAssets.logoUrl || tenant.logo_url || null,
        coverImageUrl: snapshotAssets.coverImageUrl || tenant.cover_image_url || null,
        banners: {
          ...snapshotBanners,
          ...Object.fromEntries(Object.entries(tenantBanners).filter(([, v]) => !!v)),
        },
      },
    };
  }

module.exports = router;


  res.json({
    ok: true,
    tenantSlug: tenant.slug,
    themeKey: theme.key,
    layoutKey: theme.layout_key || "classic",
    snapshotUsed,
    snapshotVersion: tenant.appearance_snapshot_version || null,
    appearance: appearanceSnapshot,
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      logo_url: tenant.logo_url,
      cover_image_url: tenant.cover_image_url || null,
      settings: {
        require_phone: (() => {
          const b = effectiveBranding || {};
          const v = b?.require_phone ?? b?.requirePhone ?? b?.phone_required ?? b?.phoneRequired;
          if (typeof v === "boolean") return v;
          if (typeof v === "string" && v.trim() !== "") {
            return ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());
          }
          return true;
        })(),
        default_phone_country_code: (() => {
          const s = String(tenant.default_phone_country_code || "").trim();
          return s || null;
        })(),
      },
      banners: tenantBanners,
      image_settings: tenantImageSettings,
      brand_overrides: tenant.brand_overrides_json || {},
      branding: effectiveBrandingWithBanners,
      theme_schema: effectiveThemeSchema,
    },
    theme: {
      key: theme.key,
      layout_key: theme.layout_key || "classic",
      tokens: theme.tokens_json || {},
    },
  });
});

module.exports = router;
