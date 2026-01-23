
// routes/adminTenantsTheme.js
import express from "express";
import db from "../db.js";

const router = express.Router();

// Ensure changelog table exists
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
}

router.post("/:tenantId/theme-schema/save-draft", async (req, res) => {
  const { tenantId } = req.params;
  const actor = req.headers["x-admin-actor"] || null;
  await ensureChangelog();
  await db.query(
    "UPDATE tenants SET theme_schema_draft_json=$1, theme_schema_draft_saved_at=NOW() WHERE id=$2",
    [req.body.schema, tenantId]
  );
  await db.query(
    "INSERT INTO tenant_theme_schema_changelog (tenant_id, action, actor) VALUES ($1,'SAVE_DRAFT',$2)",
    [tenantId, actor]
  );
  res.json({ ok: true });
});

router.post("/:tenantId/theme-schema/publish", async (req, res) => {
  const { tenantId } = req.params;
  const actor = req.headers["x-admin-actor"] || null;
  await ensureChangelog();
  await db.query(
    "UPDATE tenants SET theme_schema_published_json=theme_schema_draft_json, theme_schema_published_at=NOW() WHERE id=$1",
    [tenantId]
  );
  await db.query(
    "INSERT INTO tenant_theme_schema_changelog (tenant_id, action, actor) VALUES ($1,'PUBLISH',$2)",
    [tenantId, actor]
  );
  res.json({ ok: true });
});

router.post("/:tenantId/theme-schema/rollback", async (req, res) => {
  const { tenantId } = req.params;
  const actor = req.headers["x-admin-actor"] || null;
  await ensureChangelog();
  await db.query(
    "UPDATE tenants SET theme_schema_draft_json=theme_schema_published_json WHERE id=$1",
    [tenantId]
  );
  await db.query(
    "INSERT INTO tenant_theme_schema_changelog (tenant_id, action, actor) VALUES ($1,'ROLLBACK',$2)",
    [tenantId, actor]
  );
  res.json({ ok: true });
});

router.get("/:tenantId/theme-schema/changelog", async (req, res) => {
  const { tenantId } = req.params;
  const { rows } = await db.query(
    "SELECT * FROM tenant_theme_schema_changelog WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20",
    [tenantId]
  );
  res.json(rows);
});

export default router;
