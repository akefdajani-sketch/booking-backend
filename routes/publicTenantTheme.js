const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/:slug", async (req, res) => {
  const { slug } = req.params;

  const t = await db.query(
    `SELECT id, slug, theme_key, brand_overrides_json,
            branding,
            banner_home_url, banner_book_url, banner_account_url, banner_reservations_url,
            logo_url
     FROM tenants
     WHERE slug = $1`,
    [slug]
  );

  if (!t.rows[0]) return res.status(404).json({ error: "Tenant not found" });

  const tenant = t.rows[0];
  const themeKey = tenant.theme_key || "default_v1";

  let th = await db.query(
    "SELECT key, tokens_json, layout_key FROM platform_themes WHERE key = $1 AND is_published = TRUE",
    [themeKey]
  );

  if (!th.rows[0]) {
    th = await db.query(
      "SELECT key, tokens_json, layout_key FROM platform_themes WHERE key = 'default_v1' AND is_published = TRUE"
    );
  }

  const theme = th.rows[0] || { key: "default_v1", tokens_json: {}, layout_key: "classic" };

  // Cache theme payload briefly (themes change rarely, but reduce flicker + load).
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

  res.json({
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      logo_url: tenant.logo_url,
      banners: {
        home: tenant.banner_home_url,
        book: tenant.banner_book_url,
        account: tenant.banner_account_url,
        reservations: tenant.banner_reservations_url
      },
      brand_overrides: tenant.brand_overrides_json || {},
      branding: tenant.branding || {}
    },
    theme: {
      key: theme.key,
      layout_key: theme.layout_key || "classic",
      tokens: theme.tokens_json || {}
    }
  });
});

module.exports = router;
