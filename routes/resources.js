// routes/resources.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");

// GET /api/resources?tenantSlug=&tenantId=&includeInactive=
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive } = req.query;

    const params = [];
    let where = "";
    let idx = 1;

    if (tenantId) {
      params.push(Number(tenantId));
      where = `WHERE r.tenant_id = $${idx}`;
      idx++;
    } else if (tenantSlug) {
      params.push(String(tenantSlug));
      where = `WHERE t.slug = $${idx}`;
      idx++;
    }

    const inc =
      String(includeInactive || "").toLowerCase().trim() === "true" ||
      String(includeInactive || "").trim() === "1";

    if (!inc) {
      where += where ? " AND r.is_active = TRUE" : "WHERE r.is_active = TRUE";
    }

    const q = `
      SELECT
        r.id,
        r.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant_name,
        r.name,
        r.type AS kind,
        r.is_active,
        r.created_at
      FROM resources r
      JOIN tenants t ON t.id = r.tenant_id
      ${where}
      ORDER BY t.name ASC, r.name ASC
    `;

    const result = await db.query(q, params);
    return res.json({ resources: result.rows });
  } catch (err) {
    console.error("Error loading resources:", err);
    return res.status(500).json({ error: "Failed to load resources" });
  }
});

// POST /api/resources (admin)
// Body: { tenantSlug? | tenantId, name, kind? }
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, kind } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Resource name is required." });
    }

    let resolvedTenantId = tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      const tRes = await db.query(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [
        String(tenantSlug),
      ]);
      resolvedTenantId = tRes.rows?.[0]?.id || null;
    }

    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantId or tenantSlug." });
    }

    const insert = await db.query(
      `
      INSERT INTO resources (tenant_id, name, kind, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id, tenant_id, name, type AS kind, is_active, created_at
      `,
      [resolvedTenantId, String(name).trim(), kind ? String(kind).trim() : null]
    );

    return res.json({ resource: insert.rows[0] });
  } catch (err) {
    console.error("Error creating resource:", err);
    return res.status(500).json({ error: "Failed to create resource" });
  }
});

// DELETE /api/resources/:id (admin) soft delete
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid resource id." });

    const result = await db.query(
      `
      UPDATE resources
      SET is_active = FALSE
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (!result.rows.length) return res.status(404).json({ error: "Resource not found." });
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("Error deleting resource:", err);
    return res.status(500).json({ error: "Failed to delete resource" });
  }
});

module.exports = router;
