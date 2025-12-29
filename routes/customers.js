// routes/customers.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");

// ------------------------------------------------------------
// ADMIN: GET /api/customers?tenantSlug=&tenantId=&q=
// ------------------------------------------------------------
router.get("/", requireAdmin, async (req, res) => {
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

// ------------------------------------------------------------
// PUBLIC (Google): POST /api/customers/me
// Body: { tenantSlug, name, phone?, email? }
// Uses Google ID token from Authorization: Bearer <id_token>
// Upserts customer per tenant + google email
// ------------------------------------------------------------
router.post("/me", requireGoogleAuth, async (req, res) => {
  try {
    const { tenantSlug, name, phone, email } = req.body || {};

    if (!tenantSlug) return res.status(400).json({ error: "Missing tenantSlug." });
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required." });

    // Resolve tenant
    const tRes = await db.query(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [String(tenantSlug)]);
    const tenantId = tRes.rows?.[0]?.id;
    if (!tenantId) return res.status(400).json({ error: "Unknown tenant." });

    // Trust email from Google token (req.user.email)
    const googleEmail = req.user?.email || null;
    if (!googleEmail) return res.status(401).json({ error: "Missing Google email." });

    // If they typed an email, it must match Google email (prevents spoofing)
    if (email && String(email).trim() && String(email).trim().toLowerCase() !== String(googleEmail).toLowerCase()) {
      return res.status(400).json({ error: "Email must match your Google account." });
    }

    // Upsert on (tenant_id, email)
    const upsert = await db.query(
      `
      INSERT INTO customers (tenant_id, name, phone, email, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (tenant_id, email)
      DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone
      RETURNING id, tenant_id, name, phone, email, created_at
      `,
      [
        Number(tenantId),
        String(name).trim(),
        phone ? String(phone).trim() : null,
        String(googleEmail).trim(),
      ]
    );

    return res.json({ customer: upsert.rows[0] });
  } catch (err) {
    // If your DB doesn't have the unique constraint yet, you'll see an error here.
    console.error("Error upserting customer:", err);
    return res.status(500).json({ error: "Failed to save customer" });
  }
});

// ------------------------------------------------------------
// ADMIN: POST /api/customers  (keep admin create)
// Body: { tenantSlug? | tenantId, name, phone?, email?, notes? }
// ------------------------------------------------------------
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
