const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const { sanitizeBrandOverrides, sanitizeThemeTokens } = require("../theme/validateTokens");
const { defaultThemeSchemaV1 } = require("../theme/themeSchemaDefault");
const { schemaToCssVars } = require("../theme/resolveThemeSchema");

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

// ------------------------------
// Theme Schema (Theme OS v1)
// ------------------------------
// GET /api/admin/tenants/:tenantId/theme-schema
// Returns { draft_schema, published_schema, published_at }
router.get("/:tenantId/theme-schema", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const { rows } = await db.query(
    `SELECT id, slug,
            COALESCE(theme_schema_draft_json, '{}'::jsonb) AS draft_schema,
            COALESCE(theme_schema_published_json, '{}'::jsonb) AS published_schema,
            theme_schema_published_at
       FROM tenants
      WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

  const row = rows[0];
  // Provide a sensible default if schema is empty.
  const draft = row.draft_schema && Object.keys(row.draft_schema).length ? row.draft_schema : defaultThemeSchemaV1();
  const published = row.published_schema && Object.keys(row.published_schema).length ? row.published_schema : null;

  res.json({
    tenant: { id: row.id, slug: row.slug },
    draft_schema: draft,
    published_schema: published,
    published_at: row.theme_schema_published_at,
  });
});

// PUT /api/admin/tenants/:tenantId/theme-schema
// Body: { draft_schema }
router.put("/:tenantId/theme-schema", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const { draft_schema } = req.body || {};
  if (!draft_schema || typeof draft_schema !== "object") {
    return res.status(400).json({ error: "draft_schema object required" });
  }

  const { rows } = await db.query(
    `UPDATE tenants
        SET theme_schema_draft_json = $2::jsonb
      WHERE id = $1
      RETURNING id, slug`,
    [tenantId, JSON.stringify(draft_schema)]
  );
  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });
  res.json({ ok: true, tenant: rows[0] });
});

// POST /api/admin/tenants/:tenantId/theme-schema/publish
// Behavior:
// - Copies draft -> published
// - Computes resolved CSS vars (incl derived/glow) and writes them into brand_overrides_json
router.post("/:tenantId/theme-schema/publish", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const t = await db.query(
    `SELECT id, slug, COALESCE(theme_schema_draft_json, '{}'::jsonb) AS draft_schema
       FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  if (!t.rows[0]) return res.status(404).json({ error: "Tenant not found" });

  const draft = t.rows[0].draft_schema && Object.keys(t.rows[0].draft_schema).length ? t.rows[0].draft_schema : defaultThemeSchemaV1();
  const { derived, cssVars } = schemaToCssVars(draft);

  const { rows } = await db.query(
    `UPDATE tenants
        SET theme_schema_published_json = $2::jsonb,
            theme_schema_published_at = NOW(),
            brand_overrides_json = COALESCE(brand_overrides_json, '{}'::jsonb) || $3::jsonb
      WHERE id = $1
      RETURNING id, slug,
                COALESCE(brand_overrides_json, '{}'::jsonb) AS brand_overrides,
                theme_schema_published_at`,
    [tenantId, JSON.stringify(draft), JSON.stringify(cssVars)]
  );

  res.json({ ok: true, tenant: rows[0], derived });
});

// POST /api/admin/tenants/:tenantId/theme-schema/rollback
// Rolls back the *published* schema by re-applying published_schema -> brand_overrides_json
router.post("/:tenantId/theme-schema/rollback", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const t = await db.query(
    `SELECT id, slug, COALESCE(theme_schema_published_json, '{}'::jsonb) AS published_schema
       FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  if (!t.rows[0]) return res.status(404).json({ error: "Tenant not found" });

  const published = t.rows[0].published_schema;
  if (!published || !Object.keys(published).length) {
    return res.status(400).json({ error: "No published schema to rollback to" });
  }

  const { derived, cssVars } = schemaToCssVars(published);
  const { rows } = await db.query(
    `UPDATE tenants
        SET brand_overrides_json = COALESCE(brand_overrides_json, '{}'::jsonb) || $2::jsonb
      WHERE id = $1
      RETURNING id, slug, COALESCE(brand_overrides_json, '{}'::jsonb) AS brand_overrides`,
    [tenantId, JSON.stringify(cssVars)]
  );

  res.json({ ok: true, tenant: rows[0], derived });
});

module.exports = router;
