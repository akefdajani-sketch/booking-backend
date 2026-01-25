const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/:slug", async (req, res) => {
  const { slug } = req.params;

  const t = await db.query(
    `SELECT id, slug, theme_key, brand_overrides_json,
            banner_home_url, banner_book_url, banner_account_url, banner_reservations_url,
            logo_url
     FROM tenants
     WHERE slug = $1`,
    [slug]
  );

  if (!t.rows[0]) return res.status(404).json({ error: "Tenant not found" });

  const tenant = t.rows[0];
  const themeKey = tenant.theme_key || "default_v1";

  // Optional layout override stored in brand_overrides_json.
  // This is useful when you want the tenant to force a booking UI layout
  // (e.g. premium) without changing the theme key.
  let brandOverrides = tenant.brand_overrides_json || {};
  if (typeof brandOverrides === "string") {
    try {
      brandOverrides = JSON.parse(brandOverrides);
    } catch (_) {
      brandOverrides = {};
    }
  }
  const overrideLayoutRaw =
    brandOverrides.layout_key || brandOverrides.layout || brandOverrides.booking_layout;
  const overrideLayout =
    typeof overrideLayoutRaw === "string" ? overrideLayoutRaw.toLowerCase() : null;

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
  let tokens = theme.tokens_json || {};
  if (typeof tokens === "string") {
    try {
      tokens = JSON.parse(tokens);
    } catch (_) {
      tokens = {};
    }
  }
  const layout_key =
    overrideLayout && ["classic", "premium"].includes(overrideLayout)
      ? overrideLayout
      : theme.layout_key || "classic";

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
      brand_overrides: brandOverrides
    },
    theme: {
      key: theme.key,
      layout_key,
      tokens
    }
  });
});

module.exports = router;
