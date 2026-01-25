// routes/customers.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { requireTenant } = require("../middleware/requireTenant");

// ------------------------------------------------------------
// ADMIN: GET /api/customers/search?tenantSlug|tenantId&q=&limit=
// Lightweight search endpoint for autocomplete.
// ------------------------------------------------------------
router.get("/search", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const q = req.query.q ? String(req.query.q).trim() : "";
    const limitRaw = req.query.limit ? Number(req.query.limit) : 10;
    const limit = Math.max(1, Math.min(25, Number.isFinite(limitRaw) ? limitRaw : 10));

    if (!q) return res.json({ customers: [] });

    const like = `%${q}%`;

    const result = await db.query(
      `
      SELECT id, tenant_id, name, phone, email
      FROM customers
      WHERE tenant_id = $1
        AND (
          name ILIKE $2 OR
          phone ILIKE $2 OR
          email ILIKE $2
        )
      ORDER BY name ASC
      LIMIT $3
      `,
      [tenantId, like, limit]
    );

    return res.json({ customers: result.rows });
  } catch (err) {
    console.error("Error searching customers:", err);
    return res.status(500).json({ error: "Failed to search customers" });
  }
});

// ------------------------------------------------------------
// ADMIN: GET /api/customers?tenantSlug|tenantId&q=
// P1: tenant is REQUIRED.
// ------------------------------------------------------------
router.get("/", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const q = req.query.q ? String(req.query.q).trim() : "";

    // Optional limit (cap at 200)
    const limitRaw = req.query.limit ? Number(req.query.limit) : 200;
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 200));

    const params = [tenantId];
    let where = `WHERE c.tenant_id = $1`;

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (c.name ILIKE $2 OR c.phone ILIKE $2 OR c.email ILIKE $2)`;
    }

    // For autocomplete/search UX: order by name when q is provided, otherwise newest first
    const orderBy = q ? `ORDER BY c.name ASC` : `ORDER BY c.created_at DESC`;

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
      ${orderBy}
      LIMIT $${params.length + 1}
    `;

    const result = await db.query(query, [...params, limit]);
    return res.json({ customers: result.rows });
  } catch (err) {
    console.error("Error loading customers:", err);
    return res.status(500).json({ error: "Failed to load customers" });
  }
});

// ------------------------------------------------------------
// PUBLIC (Google): POST /api/customers/me
// Body: { tenantSlug, name, phone?, email? }
// P1: tenant resolved by slug; upsert is scoped by tenant_id.
// ------------------------------------------------------------
router.post("/me", requireGoogleAuth, async (req, res) => {
  try {
    const { tenantSlug, name, phone, email } = req.body || {};

    if (!tenantSlug) return res.status(400).json({ error: "Missing tenantSlug." });
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required." });

    const tRes = await db.query(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [String(tenantSlug)]);
    const tenantId = tRes.rows?.[0]?.id;
    if (!tenantId) return res.status(400).json({ error: "Unknown tenant." });

    const googleEmail = req.googleUser?.email || null;
    if (!googleEmail) return res.status(401).json({ error: "Missing Google email." });

    if (email && String(email).trim() && String(email).trim().toLowerCase() !== String(googleEmail).toLowerCase()) {
      return res.status(400).json({ error: "Email must match your Google account." });
    }

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
    console.error("Error upserting customer:", err);
    return res.status(500).json({ error: "Failed to save customer" });
  }
});

// ------------------------------------------------------------
// ADMIN: POST /api/customers
// Body: { tenantSlug? | tenantId, name, phone?, email?, notes? }
// P1: tenant resolved and enforced.
// ------------------------------------------------------------
// ===============================
// Customer Portal (self) endpoints
// These are used by the public booking site (customer account / history / memberships)
// Auth: Google ID token (requireGoogleAuth). Tenant: requireTenant via ?tenantSlug=...
// ===============================

// Get my booking history for a tenant
router.get("/me/bookings", requireGoogleAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id, name, email FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );

    if (cust.rows.length === 0) {
      // No customer record yet for this tenant -> empty history
      return res.json({ bookings: [] });
    }

    const customerId = cust.rows[0].id;

    const q = await pool.query(
      `
      SELECT 
        b.id,
        b.tenant_id,
        b.customer_id,
        b.service_id,
        b.resource_id,
        b.start_time,
        b.end_time,
        b.status,
        b.notes,
        b.created_at,
        s.name AS service_name,
        r.name AS resource_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id
      LEFT JOIN resources r ON r.id = b.resource_id
      WHERE b.tenant_id = $1
        AND b.customer_id = $2
      ORDER BY b.start_time DESC
      LIMIT 200
      `,
      [tenantId, customerId]
    );

    return res.json({ bookings: q.rows });
  } catch (e) {
    console.error("GET /customers/me/bookings error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Cancel one of my bookings (soft-cancel)
router.delete("/me/bookings/:id", requireGoogleAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    const bookingId = Number(req.params.id);
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });
    if (!Number.isFinite(bookingId)) return res.status(400).json({ error: "Invalid booking id" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.status(404).json({ error: "Customer not found" });
    const customerId = cust.rows[0].id;

    const check = await pool.query(
      `SELECT id, status FROM bookings WHERE id=$1 AND tenant_id=$2 AND customer_id=$3 LIMIT 1`,
      [bookingId, tenantId, customerId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: "Booking not found" });

    // If already cancelled, idempotent success
    if ((check.rows[0].status || "").toLowerCase() === "cancelled") {
      return res.json({ ok: true, bookingId, status: "cancelled" });
    }

    await pool.query(
      `UPDATE bookings SET status='cancelled' WHERE id=$1 AND tenant_id=$2 AND customer_id=$3`,
      [bookingId, tenantId, customerId]
    );

    return res.json({ ok: true, bookingId, status: "cancelled" });
  } catch (e) {
    console.error("DELETE /customers/me/bookings/:id error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get my memberships for a tenant
router.get("/me/memberships", requireGoogleAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );

    if (cust.rows.length === 0) {
      return res.json({ memberships: [] });
    }

    const customerId = cust.rows[0].id;

    const q = await pool.query(
      `
      SELECT 
        cm.*,
        mp.name AS plan_name,
        mp.type AS plan_type,
        mp.included_minutes,
        mp.included_uses,
        mp.validity_days
      FROM customer_memberships cm
      JOIN membership_plans mp ON mp.id = cm.plan_id
      WHERE cm.tenant_id = $1
        AND cm.customer_id = $2
      ORDER BY cm.created_at DESC
      LIMIT 200
      `,
      [tenantId, customerId]
    );

    return res.json({ memberships: q.rows });
  } catch (e) {
    console.error("GET /customers/me/memberships error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Subscribe/purchase a membership plan as the signed-in customer
router.post("/me/memberships/subscribe", requireGoogleAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    const { planId } = req.body || {};
    const planIdNum = Number(planId);
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });
    if (!Number.isFinite(planIdNum)) return res.status(400).json({ error: "Invalid planId" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.status(404).json({ error: "Customer not found" });
    const customerId = cust.rows[0].id;

    const plan = await pool.query(
      `SELECT id, type, included_minutes, included_uses, validity_days FROM membership_plans WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [planIdNum, tenantId]
    );
    if (plan.rows.length === 0) return res.status(404).json({ error: "Plan not found" });

    const p = plan.rows[0];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (Number(p.validity_days || 0) * 24 * 60 * 60 * 1000));

    const ins = await pool.query(
      `
      INSERT INTO customer_memberships
        (tenant_id, customer_id, plan_id, remaining_minutes, remaining_uses, started_at, expires_at, status)
      VALUES
        ($1, $2, $3, $4, $5, NOW(), $6, 'active')
      RETURNING *
      `,
      [
        tenantId,
        customerId,
        planIdNum,
        p.type === "hours" ? Number(p.included_minutes || 0) : null,
        p.type === "uses" ? Number(p.included_uses || 0) : null,
        expiresAt,
      ]
    );

    return res.json({ ok: true, membership: ins.rows[0] });
  } catch (e) {
    console.error("POST /customers/me/memberships/subscribe error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, phone, email, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Customer name is required." });
    }

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      const tRes = await db.query(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [String(tenantSlug)]);
      resolvedTenantId = tRes.rows?.[0]?.id || null;
    }

    if (!resolvedTenantId) return res.status(400).json({ error: "Missing tenantId or tenantSlug." });

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
