const express = require("express");
const router = express.Router();
const db = require("../db");
const { resolveTenantAppearanceSnapshot, writeTenantAppearanceSnapshot } = require("../theme/resolveTenantAppearanceSnapshot");

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
        [["default_phone_country_code", "appearance_snapshot_published_json", "appearance_snapshot_version", "appearance_snapshot_published_at", "cover_image_url", "tax_config"]]
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

  // 1b) Persisted source theme key mismatch — guards old snapshots that were written
  // with the wrong source_theme_key even when the tenant row has since moved to premium_v2.
  const snapshotSourceTheme = String(tenant.appearance_snapshot_source_theme_key || "").trim().toLowerCase();
  if (snapshotSourceTheme && snapshotSourceTheme !== tenantTheme) return true;

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

  // PR 131 — expose tax_config to the public booking UI so client-side
  // VAT/service-charge breakdowns on the Membership + Package purchase modals
  // work. Patch 143 previously added tax_config to /tenants/by-slug only;
  // the frontend actually uses THIS endpoint (useTenantData calls
  // /public/tenant-theme/:slug), so the earlier fix never reached the UI.
  // Schema-compat guard kept in case an older env predates migration 031.
  const taxConfigSel = (await hasTenantColumn("tax_config"))
    ? "tax_config"
    : "NULL::jsonb AS tax_config";

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
            ${taxConfigSel},
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

  // LOGO-SYNC: Logo DISPLAY settings (size + position + light variant URL)
  // are always served from the draft branding so owner changes apply to
  // the public page immediately — same UX customers already get for
  // banner uploads and image-setting focal points. These four fields
  // are the only ones we leak from draft; everything else (colors,
  // layout, copy) still requires an explicit Publish step.
  //
  // Returns an object with ONLY the keys that are actually defined in
  // the draft, so a `{...draftLogoOverlay}` spread is a no-op when the
  // owner hasn't customised anything.
  const draftAssets = draftBranding.assets && typeof draftBranding.assets === "object"
    ? draftBranding.assets
    : {};
  const draftLogoOverlay = {};
  if (typeof draftAssets.logoHeroSize   === "string" && draftAssets.logoHeroSize.trim())   draftLogoOverlay.logoHeroSize   = draftAssets.logoHeroSize;
  if (typeof draftAssets.logoDrawerSize === "string" && draftAssets.logoDrawerSize.trim()) draftLogoOverlay.logoDrawerSize = draftAssets.logoDrawerSize;
  if (typeof draftAssets.logoPosition   === "string" && draftAssets.logoPosition.trim())   draftLogoOverlay.logoPosition   = draftAssets.logoPosition;
  if (typeof draftAssets.logoLightUrl   === "string" && draftAssets.logoLightUrl.trim())   draftLogoOverlay.logoLightUrl   = draftAssets.logoLightUrl;
  // Legacy single-size field that pre-dates the split hero/drawer config.
  if (typeof draftAssets.logoSize === "string" && draftAssets.logoSize.trim()) draftLogoOverlay.logoSize = draftAssets.logoSize;

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
          // LOGO-SYNC: overlay draft logo display settings on top of the
          // published snapshot. Spread last so draft wins; absent draft
          // fields fall through to whatever the published snapshot has.
          ...draftLogoOverlay,
        },
        // Always overlay live focal point settings so they update without a publish step.
        image_settings: {
          ...(effectiveBranding.image_settings || {}),
          ...tenantImageSettings,
        },
      }
    // LOGO-SYNC: when the tenant hasn't published yet but the owner has
    // saved logo display settings in draft, surface those alone so the
    // public page reflects the saved size/position. Anything that would
    // require a published snapshot (colors, layout, copy) stays absent.
    : (Object.keys(draftLogoOverlay).length > 0
        ? {
            assets: {
              logoUrl: tenant.logo_url || null,
              coverImageUrl: tenant.cover_image_url || null,
              banners: { ...tenantBanners },
              ...draftLogoOverlay,
            },
            image_settings: { ...tenantImageSettings },
          }
        : null);

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
      appearanceSnapshot = await writeTenantAppearanceSnapshot(tenant.id);
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
        // LOGO-SYNC: same overlay applied to the snapshot path, so
        // bootstrapAssets the frontend reads stays in sync with the
        // owner's draft logo display settings.
        ...draftLogoOverlay,
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
      // PR 131 — forward tenant tax_config so the public booking UI can
      // render VAT / service-charge rows on the membership + package
      // purchase/summary modals. Null when the tenant has no tax config.
      tax_config: tenant.tax_config || null,
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
