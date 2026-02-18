const express = require("express");
const router = express.Router();
const db = require("../db");

// Public, cacheable tenant appearance payload for /book/[slug]
//
// IMPORTANT:
// - Only returns *published* branding + *published* theme schema.
// - Draft values are admin-only.
router.get("/:slug", async (req, res) => {
  const { slug } = req.params;

  const t = await db.query(
    `SELECT id, slug, theme_key, brand_overrides_json,
            branding,
            branding_published,
            publish_status,
            theme_schema_published_json,
            banner_home_url, banner_book_url, banner_account_url, banner_reservations_url, banner_memberships_url,
            logo_url
     FROM tenants
     WHERE slug = $1`,
    [slug]
  );

  if (!t.rows[0]) return res.status(404).json({ error: "Tenant not found" });

  const tenant = t.rows[0];
  const themeKey = tenant.theme_key || "default_v1";

  // Built-in theme keys that ship with the frontend layouts.
  // These must work even if `platform_themes` rows haven't been seeded yet.
  const BUILTIN_THEME_KEYS = new Set(["default_v1", "classic", "premium", "premium_light"]);

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

  // Cache theme payload briefly (themes change rarely, but reduce flicker + load).
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

  // Phase 1.5: Lock down public contract (published-only)
  // Public endpoints must NEVER leak draft/working snapshots.
  // If a tenant is not published (or published snapshot is empty), return branding=null.
  const publishedObj = tenant.branding_published && typeof tenant.branding_published === "object"
    ? tenant.branding_published
    : null;
  const hasPublished = publishedObj && Object.keys(publishedObj).length > 0;
  const isPublished = String(tenant.publish_status || "") === "published";
  const effectiveBranding = (isPublished && hasPublished) ? publishedObj : null;

  // Theme schema is served as the *published* snapshot only.
  // If tenant isn't published yet, this must be null.
  const publishedThemeSchema = tenant.theme_schema_published_json && typeof tenant.theme_schema_published_json === "object"
    ? tenant.theme_schema_published_json
    : null;
  const effectiveThemeSchema = isPublished ? publishedThemeSchema : null;

  res.json({
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      logo_url: tenant.logo_url,
      // Phase C: lightweight booking policy flags (schema-free, stored in branding json).
      settings: {
        // default true unless explicitly disabled
        require_phone: (() => {
          const b = effectiveBranding || {};
          const v = b?.require_phone ?? b?.requirePhone ?? b?.phone_required ?? b?.phoneRequired;
          if (typeof v === "boolean") return v;
          if (typeof v === "string" && v.trim() !== "") {
            return ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());
          }
          return true;
        })(),
      },
      banners: {
        home: tenant.banner_home_url,
        book: tenant.banner_book_url,
        account: tenant.banner_account_url,
        reservations: tenant.banner_reservations_url,
        memberships: tenant.banner_memberships_url,
      },
      brand_overrides: tenant.brand_overrides_json || {},
      branding: effectiveBranding,
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
