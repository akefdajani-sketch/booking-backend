const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const { sanitizeBrandOverrides, sanitizeThemeTokens } = require("../theme/validateTokens");

// GET /api/admin/tenants/:tenantId/theme-config
// Returns the tenant's selected published theme + per-tenant brand overrides.
router.get("/:tenantId/theme-config", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const { rows } = await db.query(
    `SELECT id, slug, theme_key, COALESCE(brand_overrides_json, '{}'::jsonb) AS brand_overrides
     FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

  res.json({ tenant: rows[0] });
});

// PUT /api/admin/tenants/:tenantId/theme  { theme_key }
router.put("/:tenantId/theme", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { theme_key } = req.body || {};
  if (!tenantId || !theme_key) {
    return res.status(400).json({ error: "tenantId and theme_key required" });
  }

  const theme = await db.query(
    "SELECT key FROM platform_themes WHERE key = $1 AND is_published = TRUE",
    [theme_key]
  );
  if (!theme.rows[0]) return res.status(400).json({ error: "Theme not found or not published" });

  const { rows } = await db.query(
    "UPDATE tenants SET theme_key = $2 WHERE id = $1 RETURNING id, slug, theme_key",
    [tenantId, theme_key]
  );

  res.json({ tenant: rows[0] });
});

// PUT /api/admin/tenants/:tenantId/theme-config
// Body: { theme_key?: string, brand_overrides?: { "--var": "value" } }
// - theme_key must exist + be published (when provided)
// - brand_overrides is sanitized to a strict allowlist of safe CSS vars
router.put("/:tenantId/theme-config", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const { theme_key, brand_overrides } = req.body || {};

  // Validate theme_key if provided
  if (theme_key) {
    const theme = await db.query(
      "SELECT key FROM platform_themes WHERE key = $1 AND is_published = TRUE",
      [theme_key]
    );
    if (!theme.rows[0]) {
      return res.status(400).json({ error: "Theme not found or not published" });
    }
  }

  // Tenants may override both:
  // - "brand" variables (colors/typography/semantic)
  // - layout/theme tokens (radius/padding/sizes)
  // We sanitize each set via its strict allowlist, then merge.
  const safeBrand = {
    ...sanitizeBrandOverrides(brand_overrides),
    ...sanitizeThemeTokens(brand_overrides),
  };

  const { rows } = await db.query(
    `UPDATE tenants
       SET theme_key = COALESCE($2, theme_key),
           brand_overrides_json = COALESCE($3::jsonb, brand_overrides_json)
     WHERE id = $1
     RETURNING id, slug, theme_key, COALESCE(brand_overrides_json, '{}'::jsonb) AS brand_overrides`,
    [tenantId, theme_key ?? null, JSON.stringify(safeBrand)]
  );

  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });
  res.json({ tenant: rows[0] });
});

module.exports = router;
