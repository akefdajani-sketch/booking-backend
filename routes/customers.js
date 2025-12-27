// routes/customers.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");

// GET /api/customers?tenantSlug=&tenantId=&q=
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, q } = req.query;

    const params = [];
    let where = "";
    let idx = 1;

    if (tenantId) {
      params.push(Number(tenantId));
      where = `WHERE c.tenant_id = $${idx}`;
      idx++;
    } else if (tenantSlug) {
      params.push(String(tenantSlug));
      where = `WHERE t.slug = $${idx}`;
      idx++;
    }

    if (q && String(q).trim()) {
      params.push(`%${String(q).trim()}%`);
      const cond = `(c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR c.email ILIKE $${params.length})`;
      where += where ? ` AND ${cond}` : `WHERE ${cond}`;
    }

    const query = `
      SELECT
        c.id,
        c.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant_name,
        c.name,
        c.phone,
        c.email,
        c.notes,
        c.created_at
      FROM customers c
      JOIN tenants t ON t.id = c.tenant_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT 200
    `;

    const result = await db.query(query, params);
    return res.json({ customers: result.rows });
  } catch (err) {
    console.error("Error loading customers:", err);
    return res.status(500).json({ error: "Failed to load customers" });
  }
});

// POST /api/customers (admin)
// Body: { tenantSlug? | tenantId, name, phone?, email?, notes? }
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, phone, email, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Customer name is required." });
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
      INSERT INTO customers (tenant_id, name, phone, email, notes, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, tenant_id, name, phone, email, notes, created_at
      `,
      [
        resolvedTenantId,
        String(name).trim(),
        phone ? String(phone).trim() : null,
        email ? String(email).trim() : null,
        notes ? String(notes).trim() : null,
      ]
    );

    return res.json({ customer: insert.rows[0] });
  } catch (err) {
    console.error("Error creating customer:", err);
    return res.status(500).json({ error: "Failed to create customer" });
  }
});

module.exports = router;
