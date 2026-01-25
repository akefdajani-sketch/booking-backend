// routes/adminTenantsTheme.js
// Phase C Step 4: Draft / Publish / Rollback hardening for tenant theme schema

const express = require("express");
const router = express.Router();

const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const { getPlanSummaryForTenant } = require("../utils/planEnforcement");

async function ensureColumns() {
  // Idempotent schema hardening (no separate migration required).
  // NOTE: This assumes a Postgres backend (Render), which supports ADD COLUMN IF NOT EXISTS.
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_schema_draft_json JSONB;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_schema_published_json JSONB;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_schema_draft_saved_at TIMESTAMP;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_schema_published_at TIMESTAMP;`);
}

async function ensureChangelog() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_theme_schema_changelog (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT,
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_theme_schema_changelog_tenant_time
     ON tenant_theme_schema_changelog (tenant_id, created_at DESC);`
  );
}

async function logChange(tenantId, action, actor, metadata) {
  await ensureChangelog();
  await db.query(
    "INSERT INTO tenant_theme_schema_changelog (tenant_id, action, actor, metadata) VALUES ($1, $2, $3, $4::jsonb)",
    [tenantId, action, actor || null, JSON.stringify(metadata || {})]
  );
}

// Read current draft/published info (used for status indicators)
router.get("/:tenantId/theme-schema", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureColumns();

  const { rows } = await db.query(
    `SELECT id,
            theme_schema_draft_json,
            theme_schema_published_json,
            theme_schema_draft_saved_at,
            theme_schema_published_at
     FROM tenants
     WHERE id = $1`,
    [tenantId]
  );

  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

  res.json({
    tenant_id: rows[0].id,
    draft: rows[0].theme_schema_draft_json || null,
    published: rows[0].theme_schema_published_json || null,
    draft_saved_at: rows[0].theme_schema_draft_saved_at || null,
    published_at: rows[0].theme_schema_published_at || null,
  });
});

// Save draft
router.post("/:tenantId/theme-schema/save-draft", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureColumns();

  // Accept either { schema: ... } or { draft: ... }
  const schema = (req.body && (req.body.schema ?? req.body.draft ?? req.body)) || null;
  if (!schema) return res.status(400).json({ error: "Missing draft schema" });

  const actor = String(req.headers["x-admin-actor"] || "").trim() || null;

  await db.query(
    `UPDATE tenants
     SET theme_schema_draft_json = $1::jsonb,
         theme_schema_draft_saved_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(schema), tenantId]
  );

  await logChange(tenantId, "SAVE_DRAFT", actor, { bytes: JSON.stringify(schema).length });

  res.json({ ok: true });
});

// Publish: copies draft -> published
router.post("/:tenantId/theme-schema/publish", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureColumns();

  const actor = String(req.headers["x-admin-actor"] || "").trim() || null;

  const { rows } = await db.query(
    `UPDATE tenants
     SET theme_schema_published_json = theme_schema_draft_json,
         theme_schema_published_at = NOW()
     WHERE id = $1
     RETURNING theme_schema_published_at`,
    [tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

  await logChange(tenantId, "PUBLISH", actor, {});

  res.json({ ok: true, published_at: rows[0].theme_schema_published_at });
});

// Rollback: restore draft from last published (does not change live published unless you republish)
router.post("/:tenantId/theme-schema/rollback", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureColumns();

  const actor = String(req.headers["x-admin-actor"] || "").trim() || null;

  const { rows } = await db.query(
    `UPDATE tenants
     SET theme_schema_draft_json = theme_schema_published_json,
         theme_schema_draft_saved_at = NOW()
     WHERE id = $1
     RETURNING theme_schema_published_json IS NOT NULL AS has_published`,
    [tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });
  if (!rows[0].has_published) {
    return res.status(400).json({ error: "Nothing published yet" });
  }

  await logChange(tenantId, "ROLLBACK", actor, {});

  res.json({ ok: true });
});

// Changelog: last 25 entries
router.get("/:tenantId/theme-schema/changelog", requireAdmin, async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!tenantId) return res.status(400).json({ error: "Invalid tenantId" });

  await ensureChangelog();

  const { rows } = await db.query(
    `SELECT id, tenant_id, action, actor, metadata, created_at
     FROM tenant_theme_schema_changelog
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 25`,
    [tenantId]
  );
  res.json({ entries: rows });
});

// ---------------------------------------------------------------------------
// Phase D1: Admin Plan Summary (read-only)
// GET /api/admin/tenants/:tenantId/plan-summary
// - Used by Owner/Tenant setup UI to show plan, limits, usage, and trial state.
// ---------------------------------------------------------------------------
router.get("/:tenantId/plan-summary", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }

    const summary = await getPlanSummaryForTenant(tenantId);
    return res.json(summary);
  } catch (e) {
    console.error("GET /api/admin/tenants/:tenantId/plan-summary error:", e);
    return res.status(500).json({ error: "Failed to load plan summary" });
  }
});


// ---------------------------------------------------------------------------
// Phase C Step 5: Tenant Theme Key / Layout override (platform theme selection)
// GET  /api/admin/tenants/:tenantId/theme
// PUT  /api/admin/tenants/:tenantId/theme   body: { theme_key?: string|null, layout_key?: "classic"|"premium"|null }
// ---------------------------------------------------------------------------
router.get("/:tenantId/theme", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) return res.status(400).json({ error: "Invalid tenantId" });

    const { rows } = await db.query(
      "SELECT id, slug, name, theme_key, brand_overrides_json FROM tenants WHERE id = $1",
      [tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

    const overrides = rows[0].brand_overrides_json || null;
    const layout_key =
      (overrides && (overrides.layout_key || overrides.layout || overrides.booking_layout)) || null;

    return res.json({
      tenant_id: rows[0].id,
      slug: rows[0].slug,
      name: rows[0].name,
      theme_key: rows[0].theme_key || null,
      layout_key: layout_key || null,
      brand_overrides_json: overrides,
    });
  } catch (e) {
    console.error("GET /api/admin/tenants/:tenantId/theme error:", e);
    return res.status(500).json({ error: "Failed to load tenant theme" });
  }
});

router.put("/:tenantId/theme", requireAdmin, async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) return res.status(400).json({ error: "Invalid tenantId" });

    const theme_key_raw = req.body?.theme_key;
    const layout_raw = req.body?.layout_key;

    const theme_key =
      theme_key_raw === null || theme_key_raw === "" || typeof theme_key_raw === "undefined"
        ? null
        : String(theme_key_raw).trim();

    const layout_key =
      layout_raw === null || layout_raw === "" || typeof layout_raw === "undefined"
        ? null
        : String(layout_raw).trim().toLowerCase();

    if (layout_key && !["classic", "premium"].includes(layout_key)) {
      return res.status(400).json({ error: "layout_key must be classic or premium" });
    }

    // Update theme_key and brand_overrides_json.layout_key (if provided)
    // - If layout_key is null, we remove layout_key from overrides (fallback to theme default).
    // - If theme_key is null, public endpoint falls back to default_v1.
    const { rows } = await db.query(
      `
      UPDATE tenants
      SET theme_key = $2,
          brand_overrides_json = CASE
            WHEN $3::text IS NULL THEN COALESCE(brand_overrides_json, '{}'::jsonb) - 'layout_key' - 'layout' - 'booking_layout'
            ELSE jsonb_set(COALESCE(brand_overrides_json, '{}'::jsonb), '{layout_key}', to_jsonb($3::text), true)
          END
      WHERE id = $1
      RETURNING id, slug, name, theme_key, brand_overrides_json
      `,
      [tenantId, theme_key, layout_key]
    );
    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

    return res.json({ ok: true, tenant: rows[0] });
  } catch (e) {
    console.error("PUT /api/admin/tenants/:tenantId/theme error:", e);
    return res.status(500).json({ error: "Failed to update tenant theme" });
  }
});

module.exports = router;
