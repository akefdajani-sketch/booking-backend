// meProfile.js
// Customer self-service profile routes: POST /me, GET /me, GET /me/session, GET /me/versions
// Mounted by routes/customers.js

const express = require("express");
const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { getExistingColumns, firstExisting, pickCol, softDeleteClause, safeIntExpr, getErrorCode } = require("../../utils/customerQueryHelpers");


module.exports = function mount(router) {
router.post("/me", requireAppAuth, async (req, res) => {
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
        -- Preserve existing phone if client sends null/empty
        phone = COALESCE(NULLIF(EXCLUDED.phone, ''), customers.phone)
      RETURNING id, tenant_id, name, phone, email, avatar_url, created_at
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

// ------------------------------------------------------------
// GET /api/customers/me
// Returns the signed-in customer's profile for this tenant.
// If the customer does not exist yet, returns { customer: null }.
// ------------------------------------------------------------
router.get("/me", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id, tenant_id, name, phone, email, avatar_url, created_at
       FROM customers
       WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)
       LIMIT 1`,
      [tenantId, email]
    );

    return res.json({ customer: cust.rows[0] || null });
  } catch (e) {
    console.error("GET /customers/me error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------------
// GET /api/customers/me/session
// Lightweight auth check for the booking UI.
// ------------------------------------------------------------
router.get("/me/session", requireAppAuth, requireTenant, async (req, res) => {
  try {
    return res.json({ ok: true, email: req.googleUser?.email || null });
  } catch (e) {
    console.error("GET /customers/me/session error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------------
// GET /api/customers/me/versions
// Customer-scoped change signals for the public booking UI.
//
// Returns monotonic-ish timestamps (epoch ms) that change when:
// - this customer's bookings change
// - this customer's memberships/ledger change
//
// The booking UI can poll this cheaply and only refetch heavy payloads
// (history/memberships) when a version changes.
// ------------------------------------------------------------
router.get("/me/versions", requireAppAuth, requireTenant, async (req, res) => {
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
      return res.json({ bookingsVersion: 0, membershipsVersion: 0 });
    }

    const customerId = cust.rows[0].id;

    // bookings version = MAX(COALESCE(updated_at, created_at)) for this customer
    const bUpdated = await pickCol("bookings", "b", ["updated_at", "updatedAt"], "NULL");
    const bCreated = await pickCol("bookings", "b", ["created_at", "createdAt"], "NULL");
    const bTouch = `COALESCE(${bUpdated}, ${bCreated})`;

    const bookingsRes = await pool.query(
      `SELECT MAX(${bTouch}) AS max_ts
       FROM bookings b
       WHERE b.tenant_id=$1 AND b.customer_id=$2`,
      [tenantId, customerId]
    );

    const bookingsTs = bookingsRes.rows?.[0]?.max_ts ? new Date(bookingsRes.rows[0].max_ts).getTime() : 0;

    // memberships version = max of:
    // - customer_memberships MAX(COALESCE(updated_at, created_at/started_at))
    // - membership_ledger MAX(created_at) joined via customer_memberships
    const cmUpdated = await pickCol("customer_memberships", "cm", ["updated_at", "updatedAt"], "NULL");
    const cmCreated = await pickCol(
      "customer_memberships",
      "cm",
      ["created_at", "createdAt", "started_at", "start_at"],
      "NULL"
    );
    const cmTouch = `COALESCE(${cmUpdated}, ${cmCreated})`;

    const cmRes = await pool.query(
      `SELECT MAX(${cmTouch}) AS max_ts
       FROM customer_memberships cm
       WHERE cm.tenant_id=$1 AND cm.customer_id=$2`,
      [tenantId, customerId]
    );

    const mlCreated = await pickCol("membership_ledger", "ml", ["created_at", "createdAt"], "NULL");
    const mlRes = await pool.query(
      `SELECT MAX(${mlCreated}) AS max_ts
       FROM membership_ledger ml
       JOIN customer_memberships cm ON cm.id = ml.customer_membership_id
       WHERE cm.tenant_id=$1 AND cm.customer_id=$2`,
      [tenantId, customerId]
    );

    const cmTs = cmRes.rows?.[0]?.max_ts ? new Date(cmRes.rows[0].max_ts).getTime() : 0;
    const mlTs = mlRes.rows?.[0]?.max_ts ? new Date(mlRes.rows[0].max_ts).getTime() : 0;
    const membershipsTs = Math.max(cmTs, mlTs);

    return res.json({ bookingsVersion: bookingsTs, membershipsVersion: membershipsTs });
  } catch (e) {
    console.error("GET /customers/me/versions error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});
};
