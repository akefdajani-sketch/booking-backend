// routes/customers.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
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

function getErrorCode(err) {
  return err?.code || err?.sqlState || err?.original?.code || null;
}

// ------------------------------------------------------------
// ADMIN: GET /api/customers/search?tenantSlug|tenantId&q=&limit=
// Lightweight search endpoint for autocomplete.
// ------------------------------------------------------------
router.get("/search", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
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
router.get("/", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
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

// ------------------------------------------------------------
// GET /api/customers/me
// Returns the signed-in customer's profile for this tenant.
// If the customer does not exist yet, returns { customer: null }.
// ------------------------------------------------------------
router.get("/me", requireGoogleAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id, tenant_id, name, phone, email, created_at
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
router.get("/me/session", requireGoogleAuth, requireTenant, async (req, res) => {
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
router.get("/me/versions", requireGoogleAuth, requireTenant, async (req, res) => {
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

    // Newer DBs: invoice metadata + customer/staff fields.
    // Keep schema-tolerant via pickCol.
    const bookingCode = await pickCol("bookings", "b", ["booking_code"], "NULL");
    const customerName = await pickCol("bookings", "b", ["customer_name"], "NULL");
    const customerEmail = await pickCol("bookings", "b", ["customer_email"], "NULL");
    const customerPhone = await pickCol("bookings", "b", ["customer_phone"], "NULL");
    const staffName = await pickCol("bookings", "b", ["staff_name"], "NULL");

    const q = await pool.query(
      `
      SELECT
        b.id,
        b.tenant_id,
        b.customer_id,
        b.service_id,
        b.staff_id,
        b.resource_id,
        ${startTime} AS start_time,
        ${duration} AS duration_minutes,
        ${status} AS status,
        ${notes} AS notes,
        ${createdAt} AS created_at,
        ${bookingCode} AS booking_code,
        b.customer_membership_id,
        mp.name AS membership_plan_name,
        cmem.minutes_remaining AS membership_minutes_remaining,
        cmem.uses_remaining AS membership_uses_remaining,
        mu.minutes_used AS membership_minutes_used_for_booking,
        mu.uses_used AS membership_uses_used_for_booking,
        COALESCE(${customerName}, c.name) AS customer_name,
        COALESCE(${customerEmail}, c.email) AS customer_email,
        COALESCE(${customerPhone}, c.phone) AS customer_phone,
        COALESCE(s.name, ${serviceName}) AS service_name,
        COALESCE(st.name, ${staffName}) AS staff_name,
        COALESCE(r.name, ${resourceName}) AS resource_name
      FROM bookings b
      LEFT JOIN customers c ON c.id = b.customer_id
      LEFT JOIN services s ON s.id = b.service_id
      LEFT JOIN staff st ON st.id = b.staff_id
      LEFT JOIN resources r ON r.id = b.resource_id
      LEFT JOIN customer_memberships cmem ON cmem.id = b.customer_membership_id
      LEFT JOIN membership_plans mp ON mp.id = cmem.plan_id
      LEFT JOIN LATERAL (
        SELECT
          SUM(CASE WHEN ml.minutes_delta < 0 THEN -ml.minutes_delta ELSE 0 END)::int AS minutes_used,
          SUM(CASE WHEN ml.uses_delta < 0 THEN -ml.uses_delta ELSE 0 END)::int AS uses_used
        FROM membership_ledger ml
        WHERE ml.booking_id = b.id
          AND (b.customer_membership_id IS NULL OR ml.customer_membership_id = b.customer_membership_id)
      ) mu ON true
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

// NOTE:
// There is a second /me/memberships route further below that is schema-tolerant
// (it only selects columns that exist). We intentionally keep ONLY that route.

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
    //
    // IMPORTANT (money-trust): The current platform uses an append-only ledger
    // with customer_memberships.minutes_remaining / uses_remaining as the
    // authoritative cached balances. Older iterations used included/used
    // minutes. This endpoint must support BOTH shapes so the public booking UI
    // can reliably determine if the customer has spendable credits.
    const cmPlanId = await pickCol("customer_memberships", "cm", [
      "plan_id",
      "membership_plan_id",
    ]);

    const cmStatusRaw = await pickCol("customer_memberships", "cm", ["status"], "NULL");
    const cmStarted = await pickCol(
      "customer_memberships",
      "cm",
      ["started_at", "start_at", "created_at"],
      "NULL"
    );
    const cmEndAt = await pickCol(
      "customer_memberships",
      "cm",
      ["end_at", "expires_at", "valid_until"],
      "NULL"
    );

    // Ledger-era balances (preferred when columns exist)
    const cmMinutesRemaining = await pickCol(
      "customer_memberships",
      "cm",
      ["minutes_remaining"],
      "NULL"
    );
    const cmUsesRemaining = await pickCol(
      "customer_memberships",
      "cm",
      ["uses_remaining"],
      "NULL"
    );

    // Legacy minutes fields (fallback)
    const cmUsedLegacy = await pickCol(
      "customer_memberships",
      "cm",
      ["used_minutes", "minutes_used"],
      "NULL"
    );
    const cmIncludedLegacy = await pickCol(
      "customer_memberships",
      "cm",
      ["included_minutes", "minutes_total", "minutes_included"],
      "NULL"
    );

    const mpName = await pickCol("membership_plans", "mp", ["name", "title"], "NULL");
    const mpDesc = await pickCol(
      "membership_plans",
      "mp",
      ["description", "subtitle"],
      "NULL"
    );
    const mpIncluded = await pickCol(
      "membership_plans",
      "mp",
      ["included_minutes", "minutes_total", "minutes_included"],
      "NULL"
    );

    const mpIncludedUses = await pickCol(
      "membership_plans",
      "mp",
      ["included_uses", "uses_total", "uses_included"],
      "NULL"
    );

    // Prefer ledger-era minutes_remaining when available; otherwise compute from included-used.
    const legacyIncludedExpr = `COALESCE(${mpIncluded}, ${cmIncludedLegacy})`;
    const legacyUsedExpr = `COALESCE(${cmUsedLegacy}, 0)`;
    const legacyRemainingExpr = `CASE WHEN ${legacyIncludedExpr} IS NOT NULL THEN GREATEST(${legacyIncludedExpr} - ${legacyUsedExpr}, 0) ELSE NULL END`;

    const minutesRemainingExpr = `COALESCE(${cmMinutesRemaining}, ${legacyRemainingExpr})`;
    const usesRemainingExpr = `COALESCE(${cmUsesRemaining}, 0)`;

    // Normalize status so the UI doesn't show "active" when end_at has passed.
    // If status column doesn't exist, we treat it as 'active' until end_at.
    const statusExpr = `CASE
      -- Time expiry
      WHEN ${cmEndAt} IS NOT NULL AND ${cmEndAt} <= NOW() THEN 'expired'

      -- Credit expiry (Option A: sessions/classes are uses)
      WHEN (COALESCE(${mpIncluded}, 0) > 0 AND (${minutesRemainingExpr}) <= 0) THEN 'expired'
      WHEN (COALESCE(${mpIncludedUses}, 0) > 0 AND (${usesRemainingExpr}) <= 0) THEN 'expired'

      -- Fallback: if plan credit shape is unknown, treat "both depleted" as expired
      WHEN (${mpIncluded} IS NULL AND ${mpIncludedUses} IS NULL)
        AND (COALESCE(${minutesRemainingExpr}, 0) <= 0 AND COALESCE(${usesRemainingExpr}, 0) <= 0) THEN 'expired'

      WHEN ${cmStatusRaw} IS NULL THEN 'active'
      WHEN LOWER(${cmStatusRaw}::text) IN ('active','cancelled','expired') THEN LOWER(${cmStatusRaw}::text)
      ELSE LOWER(${cmStatusRaw}::text)
    END`;

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
        ${statusExpr} AS status,
        ${cmStarted} AS started_at,
        ${cmEndAt} AS end_at,
        ${minutesRemainingExpr}::int AS minutes_remaining,
        ${usesRemainingExpr}::int AS uses_remaining,
        ${minutesRemainingExpr}::int AS remaining_minutes,
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

// -----------------------------------------------------------------------------
// GET /customers/me/memberships/:id/ledger
// Customer self-service ledger/usage history for a specific membership.
// Returns { ledger: [...] }
// -----------------------------------------------------------------------------
router.get(
  "/me/memberships/:id/ledger",
  requireGoogleAuth,
  requireTenant,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const email = req.user?.email;
      const membershipId = Number(req.params.id);

      if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
      if (!email) return res.status(401).json({ error: "Missing user" });
      if (!Number.isFinite(membershipId)) {
        return res.status(400).json({ error: "Invalid membership id" });
      }

      // Resolve the customer record for this tenant + Google user
      const customerRes = await db.query(
        `SELECT id FROM customers WHERE tenant_id=$1 AND email=$2 LIMIT 1`,
        [tenantId, email]
      );
      const customerId = customerRes.rows?.[0]?.id;
      if (!customerId) {
        // User has no customer record for this tenant yet
        return res.json({ ledger: [] });
      }

      // Ensure the membership belongs to this customer + tenant
      const cmRes = await db.query(
        `SELECT id FROM customer_memberships
         WHERE id=$1 AND tenant_id=$2 AND customer_id=$3
         LIMIT 1`,
        [membershipId, tenantId, customerId]
      );
      if (!cmRes.rows?.[0]?.id) {
        return res.json({ ledger: [] });
      }

      // Ledger rows (keep shape consistent with memberships.js)
      const ledgerRes = await db.query(
        `SELECT id, customer_membership_id, type, minutes_delta, uses_delta, note, created_at
         FROM membership_ledger
         WHERE customer_membership_id=$1
         ORDER BY created_at DESC
         LIMIT 200`,
        [membershipId]
      );

      return res.json({ ledger: ledgerRes.rows || [] });
    } catch (err) {
      console.error("GET /customers/me/memberships/:id/ledger error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

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

    // membership_plans has had a few schema iterations (type vs billing_type).
    const mpCols = await getExistingColumns("membership_plans");
    const planTypeCol = firstExisting(mpCols, ["type", "billing_type"]);
    const planNameCol = firstExisting(mpCols, ["name", "title"]);

    const plan = await pool.query(
      `
      SELECT
        id,
        ${planNameCol ? planNameCol : "NULL"} AS name,
        ${planTypeCol ? planTypeCol : "NULL"} AS plan_type,
        included_minutes,
        included_uses,
        validity_days
      FROM membership_plans
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1
      `,
      [planIdNum, tenantId]
    );
    if (plan.rows.length === 0) return res.status(404).json({ error: "Plan not found" });

    const p = plan.rows[0];
    const includedMinutes = Number(p.included_minutes || 0);
    const includedUses = p.included_uses == null ? null : Number(p.included_uses);
    const validityDays = Number(p.validity_days || 0);

    const now = new Date();
    const endAt = validityDays > 0
      ? new Date(now.getTime() + (validityDays * 24 * 60 * 60 * 1000))
      : null;

    await pool.query("BEGIN");

    try {
      // -------------------------------------------------------------------
      // Option A (agreed): sessions/classes/visits are "uses". Birdie is minutes.
      //
      // A membership is effectively expired if:
      // - time-based: end_at <= NOW()
      // - credit-based: minutes_remaining <= 0 OR uses_remaining <= 0 (depending on plan)
      // - hybrid: either of the above
      //
      // We allow repurchase once it's effectively expired.
      // -------------------------------------------------------------------

      // 1) Auto-expire any "active" rows that are effectively expired (time OR credits).
      //    This prevents a stale active row from blocking renewals.
      await pool.query(
        `
        UPDATE customer_memberships
        SET status = 'expired'
        WHERE tenant_id = $1
          AND customer_id = $2
          AND plan_id = $3
          AND status = 'active'
          AND (
            (end_at IS NOT NULL AND end_at <= NOW())
            OR (COALESCE(minutes_remaining, 0) <= 0 AND COALESCE(uses_remaining, 0) <= 0)
          )
        `,
        [tenantId, customerId, planIdNum]
      );

      // 2) If there is still an active membership for this plan, return it (idempotent).
      const existing = await pool.query(
        `
        SELECT id, tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining
        FROM customer_memberships
        WHERE tenant_id=$1 AND customer_id=$2 AND plan_id=$3 AND status='active'
        ORDER BY id DESC
        LIMIT 1
        `,
        [tenantId, customerId, planIdNum]
      );

      if (existing.rows.length > 0) {
        await pool.query("COMMIT");
        return res.json({ ok: true, alreadyActive: true, membership: existing.rows[0] });
      }

      // 3) Create a fresh membership row.
      let membership;
      try {
        const ins = await pool.query(
          `
          INSERT INTO customer_memberships
            (tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining)
          VALUES
            ($1, $2, $3, 'active', $4, $5, $6, $7)
          RETURNING id, tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining
          `,
          [
            tenantId,
            customerId,
            planIdNum,
            now.toISOString(),
            endAt ? endAt.toISOString() : null,
            // Balances are derived from the membership_ledger; initialize to 0.
            0,
            0,
          ]
        );
        membership = ins.rows[0];
      } catch (eIns) {
        // If there is a race, the unique constraint may fire. Return the active membership cleanly.
        if (eIns && eIns.code === "23505" && String(eIns.constraint || "") === "uq_cm_one_active_per_plan") {
          const raced = await pool.query(
            `
            SELECT id, tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining
            FROM customer_memberships
            WHERE tenant_id=$1 AND customer_id=$2 AND plan_id=$3 AND status='active'
            ORDER BY id DESC
            LIMIT 1
            `,
            [tenantId, customerId, planIdNum]
          );
          if (raced.rows.length > 0) {
            await pool.query("COMMIT");
            return res.json({ ok: true, alreadyActive: true, membership: raced.rows[0] });
          }
        }
        throw eIns;
      }

      // 4) Create the initial GRANT row in the ledger (money-truth).
      await pool.query(
        `
        INSERT INTO membership_ledger
          (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
        VALUES
          ($1, $2, NULL, 'grant', $3, $4, $5)
        `,
        [
          tenantId,
          membership.id,
          includedMinutes || null,
          (includedUses == null ? 0 : includedUses),
          `Initial grant for plan ${planIdNum}${p.name ? ` (${p.name})` : ""}`,
        ]
      );

      await pool.query("COMMIT");
      return res.json({ ok: true, alreadyActive: false, membership });
    } catch (e2) {
      await pool.query("ROLLBACK");
      console.error("POST /customers/me/memberships/subscribe DB error:", e2);
      return res.status(500).json({ error: "Server error" });
    }
  } catch (e) {
    console.error("POST /customers/me/memberships/subscribe error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
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


// Delete a customer (tenant staff/admin)
router.delete("/:customerId", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.params.customerId);
    if (!Number.isFinite(customerId)) {
      return res.status(400).json({ error: "Invalid customerId" });
    }

    try {
      const del = await db.query(
        `DELETE FROM customers WHERE id = $1 AND tenant_id = $2`,
        [customerId, tenantId]
      );
      if (!del.rowCount) {
        return res.status(404).json({ error: "Customer not found." });
      }
      return res.json({ ok: true });
    } catch (dbErr) {
      // Postgres FK violation
      if (getErrorCode(dbErr) === "23503") {
        return res.status(409).json({
          error: "Customer has related records (e.g., bookings). Remove those first.",
          code: "FK_VIOLATION",
        });
      }
      throw dbErr;
    }
  } catch (err) {
    console.error("Error deleting customer:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;