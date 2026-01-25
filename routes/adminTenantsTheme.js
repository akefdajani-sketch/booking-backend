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

module.exports = router;
