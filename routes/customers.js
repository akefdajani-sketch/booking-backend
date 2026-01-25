// routes/customers.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { requireTenant } = require("../middleware/requireTenant");

// -----------------------------------------------------------------------------
// Schema compatibility helpers
//
// Postgres throws an error if a query references a column that doesn't exist,
// even inside COALESCE(). Since this codebase has had a few schema iterations
// (start_time vs start_at, billing_type vs type, etc.), we detect available
// columns at runtime and build SELECT clauses safely.
//
// This removes the "guessing" and prevents 500s when a column is missing.
// -----------------------------------------------------------------------------

const _columnsCache = new Map(); // tableName -> Set(column_name)

async function getExistingColumns(tableName) {
  if (_columnsCache.has(tableName)) return _columnsCache.get(tableName);
  const res = await db.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1`,
    [tableName]
  );
  const set = new Set(res.rows.map((r) => r.column_name));
  _columnsCache.set(tableName, set);
  return set;
}

function firstExisting(colSet, candidates) {
  for (const c of candidates) {
    if (c && colSet.has(c)) return c;
  }
  return null;
}

async function pickCol(tableName, alias, candidates, fallbackSql = "NULL") {
  const cols = await getExistingColumns(tableName);
  const col = firstExisting(cols, candidates);
  return col ? `${alias}.${col}` : fallbackSql;
}

function safeIntExpr(sql) {
  // Ensure numeric-ish expressions don't break JSON consumers
  return `COALESCE((${sql})::int, 0)`;
}

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

    // IMPORTANT: Postgres will ERROR if we reference a column that doesn't exist
    // (even inside COALESCE). So we dynamically pick the right columns at runtime.
    const startTime = await pickCol("bookings", "b", ["start_time", "start_at", "start_datetime"], "NULL");
    const endTime = await pickCol("bookings", "b", ["end_time", "end_at", "end_datetime"], "NULL");
    const duration = await pickCol(
      "bookings",
      "b",
      ["duration_minutes", "duration_mins", "duration"],
      `CASE
        WHEN ${endTime} IS NOT NULL AND ${startTime} IS NOT NULL
          THEN ROUND(EXTRACT(EPOCH FROM (${endTime} - ${startTime})) / 60.0)::int
        ELSE NULL
      END`
    );
    const status = await pickCol("bookings", "b", ["status"], "NULL");
    const createdAt = await pickCol("bookings", "b", ["created_at"], "NOW()");
    // Some DBs don't have notes; keep the response shape stable.
    const notes = await pickCol("bookings", "b", ["notes", "customer_notes"], "NULL");
    const serviceName = await pickCol("bookings", "b", ["service_name"], "NULL");
    const resourceName = await pickCol("bookings", "b", ["resource_name"], "NULL");

    const q = await pool.query(
      `
      SELECT
        b.id,
        b.tenant_id,
        b.customer_id,
        b.service_id,
        b.resource_id,
        ${startTime} AS start_time,
        ${duration} AS duration_minutes,
        ${status} AS status,
        ${notes} AS notes,
        ${createdAt} AS created_at,
        COALESCE(s.name, ${serviceName}) AS service_name,
        COALESCE(r.name, ${resourceName}) AS resource_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id
      LEFT JOIN resources r ON r.id = b.resource_id
      WHERE b.tenant_id = $1
        AND b.customer_id = $2
      ORDER BY ${startTime} DESC
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
    const tenantId = req.tenant?.id;
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

    // Column names in customer_memberships / membership_plans have changed over
    // time. Build a query that only references columns that exist.
    const cmPlanId = await pickCol("customer_memberships", "cm", [
      "plan_id",
      "membership_plan_id",
    ]);
    const cmStatus = await pickCol("customer_memberships", "cm", ["status"], "NULL");
    const cmStarted = await pickCol("customer_memberships", "cm", [
      "started_at",
      "start_at",
      "created_at",
    ], "NULL");
    const cmExpires = await pickCol("customer_memberships", "cm", [
      "expires_at",
      "end_at",
      "valid_until",
    ], "NULL");
    const cmUsed = await pickCol("customer_memberships", "cm", [
      "used_minutes",
      "minutes_used",
    ], "NULL");
    const cmIncluded = await pickCol("customer_memberships", "cm", [
      "included_minutes",
      "minutes_total",
      "minutes_included",
    ], "NULL");

    const mpName = await pickCol("membership_plans", "mp", ["name", "title"], "NULL");
    const mpDesc = await pickCol(
      "membership_plans",
      "mp",
      ["description", "subtitle"],
      "NULL"
    );
    const mpIncluded = await pickCol("membership_plans", "mp", [
      "included_minutes",
      "minutes_total",
      "minutes_included",
    ], "NULL");

    const includedExpr = `COALESCE(${mpIncluded}, ${cmIncluded})`;
    const usedExpr = `COALESCE(${cmUsed}, 0)`;
    const remainingExpr = `CASE WHEN ${includedExpr} IS NOT NULL THEN GREATEST(${includedExpr} - ${usedExpr}, 0) ELSE NULL END`;
    const orderCol = await pickCol(
      "customer_memberships",
      "cm",
      ["created_at", "started_at", "start_at"],
      "cm.id"
    );

    const q = await pool.query(
      `
      SELECT
        cm.id,
        cm.tenant_id,
        cm.customer_id,
        ${cmPlanId} AS plan_id,
        ${cmStatus} AS status,
        ${cmStarted} AS started_at,
        ${cmExpires} AS expires_at,
        ${includedExpr} AS included_minutes,
        ${usedExpr} AS used_minutes,
        ${remainingExpr} AS remaining_minutes,
        ${mpName} AS plan_name,
        ${mpDesc} AS plan_description
      FROM customer_memberships cm
      LEFT JOIN membership_plans mp ON mp.id = ${cmPlanId}
      WHERE cm.tenant_id = $1
        AND cm.customer_id = $2
      ORDER BY ${orderCol} DESC NULLS LAST, cm.id DESC
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
    const tenantId = req.tenant?.id;
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
