// admin.js
// Admin-only customer routes: search, list, create, delete, restore
// Mounted by routes/customers.js

const express = require("express");
const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { getExistingColumns, firstExisting, pickCol, softDeleteClause, safeIntExpr, getErrorCode } = require("../../utils/customerQueryHelpers");


module.exports = function mount(router) {
router.get("/search", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const q = req.query.q ? String(req.query.q).trim() : "";
    const limitRaw = req.query.limit ? Number(req.query.limit) : 10;
    const limit = Math.max(1, Math.min(25, Number.isFinite(limitRaw) ? limitRaw : 10));

    if (!q) return res.json({ customers: [] });

    const like = `%${q}%`;

    // PR-10: exclude soft-deleted customers
    const sdSearch = await softDeleteClause("customers", "customers");

    const result = await db.query(
      `
      SELECT id, tenant_id, name, phone, email
      FROM customers
      WHERE tenant_id = $1
        ${sdSearch}
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

    // PR-3: pagination — limit + offset + total meta
    const limitRaw  = req.query.limit  ? Number(req.query.limit)  : 50;
    const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
    const limit  = Math.max(1, Math.min(200, Number.isFinite(limitRaw)  ? limitRaw  : 50));
    const offset = Math.max(0,              Number.isFinite(offsetRaw) ? offsetRaw : 0);

    const params = [tenantId];
    // PR-10: always exclude soft-deleted customers
    const sdList = await softDeleteClause("customers", "c");
    let where = `WHERE c.tenant_id = $1 ${sdList}`;

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (c.name ILIKE $2 OR c.phone ILIKE $2 OR c.email ILIKE $2)`;
    }

    // For autocomplete/search UX: order by name when q is provided, otherwise newest first
    const orderBy = q ? `ORDER BY c.name ASC` : `ORDER BY c.created_at DESC`;

    // Count query for meta
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM customers c ${where}`,
      params
    );
    const total = countResult.rows[0]?.total ?? 0;

    const dataQuery = `
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
      OFFSET $${params.length + 2}
    `;

    const result = await db.query(dataQuery, [...params, limit, offset]);

    return res.json({
      customers: result.rows,
      meta: {
        total,
        limit,
        offset,
        hasMore: offset + result.rows.length < total,
      },
    });
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



// Update customer details (name, phone, email, notes)
router.patch("/:customerId", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.params.customerId);
    if (!Number.isFinite(customerId)) {
      return res.status(400).json({ error: "Invalid customerId" });
    }

    const { name, phone, email, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Customer name is required." });
    }

    const result = await db.query(
      `UPDATE customers
       SET name = \$1, phone = \$2, email = \$3, notes = \$4, updated_at = NOW()
       WHERE id = \$5 AND tenant_id = \$6 AND deleted_at IS NULL
       RETURNING id, tenant_id, name, phone, email, notes, created_at, updated_at`,
      [
        String(name).trim(),
        phone ? String(phone).trim() : null,
        email ? String(email).trim() : null,
        notes ? String(notes).trim() : null,
        customerId,
        tenantId,
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Customer not found." });
    }
    return res.json({ customer: result.rows[0] });
  } catch (err) {
    console.error("Error updating customer:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a customer (tenant staff/admin)
// PR-10: soft-delete (sets deleted_at) instead of hard DELETE
router.delete("/:customerId", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.params.customerId);
    if (!Number.isFinite(customerId)) {
      return res.status(400).json({ error: "Invalid customerId" });
    }

    const result = await db.query(
      `UPDATE customers SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [customerId, tenantId]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Customer not found." });
    }
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("Error deleting customer:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PR-10: restore a soft-deleted customer
router.patch("/:customerId/restore", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.params.customerId);
    if (!Number.isFinite(customerId)) {
      return res.status(400).json({ error: "Invalid customerId" });
    }

    const result = await db.query(
      `UPDATE customers SET deleted_at = NULL WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL RETURNING *`,
      [customerId, tenantId]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Customer not deleted or not found." });
    }
    return res.json({ ok: true, customer: result.rows[0] });
  } catch (err) {
    console.error("Error restoring customer:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


// -----------------------------------------------------------------------------
// Customer Packages (Prepaid Products) — Customer Portal foundation
//
// Endpoints (tenant scoped via requireTenant):
//   GET  /api/customers/me/packages?tenantSlug=...
//   GET  /api/customers/me/packages/:entitlementId/ledger?tenantSlug=...
//   POST /api/customers/me/packages/:prepaidProductId/purchase?tenantSlug=...
//
// Notes:
// - Uses existing prepaid tables: prepaid_products, customer_prepaid_entitlements, prepaid_transactions.
// - Normalizes response fields to keep frontend stable.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// PR 124 — companion to frontend B3.2 (Customer detail drawer).
// GET /api/customers/:customerId/bookings
//
// Admin-scoped: tenant owner / staff can see a specific customer's booking
// history. Used by the customer drawer to render Bookings sub-tab.
//
// Query params:
//   tenantSlug  — required (resolved to tenantId via requireTenant)
//   limit       — 1-100, default 25
//   offset      — default 0
//   status      — optional filter (confirmed, cancelled, pending, no_show)
// -----------------------------------------------------------------------------
router.get(
  "/:customerId/bookings",
  requireTenant,
  requireAdminOrTenantRole("staff"),
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const customerId = Number(req.params.customerId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        return res.status(400).json({ error: "Invalid customerId." });
      }

      const limitRaw = req.query.limit ? Number(req.query.limit) : 25;
      const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 25));
      const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
      const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

      const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
      const validStatuses = new Set(["confirmed", "cancelled", "pending", "no_show"]);
      const statusFilter = status && validStatuses.has(status) ? status : null;

      // Verify the customer belongs to this tenant (defence-in-depth — the
      // tenantId filter below would already scope correctly, but this
      // returns a cleaner 404 if a stale ID is used cross-tenant).
      const ownerCheck = await db.query(
        `SELECT id FROM customers WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [customerId, tenantId]
      );
      if (ownerCheck.rowCount === 0) {
        return res.status(404).json({ error: "Customer not found for this tenant." });
      }

      const params = [tenantId, customerId];
      let whereStatus = "";
      if (statusFilter) {
        params.push(statusFilter);
        whereStatus = ` AND b.status = $${params.length}`;
      }

      params.push(limit, offset);

      const q = `
        SELECT
          b.id, b.tenant_id, b.customer_id,
          b.service_id, COALESCE(s.name, 'Unknown') AS service_name,
          b.staff_id,   COALESCE(st.name, NULL)    AS staff_name,
          b.resource_id, COALESCE(r.name, NULL)    AS resource_name,
          b.start_time,
          -- Production DB drift fix (§3.5 customer drawer 500 error):
          -- production DB lacks bookings.end_time AND bookings.updated_at.
          -- Compute end_time from start_time + duration_minutes (pattern
          -- proven in utils/bookings.js); return NULL for updated_at since
          -- it's not in the API contract that callers depend on. If a
          -- migration is later run that adds these columns, swap these
          -- expressions back to b.end_time / b.updated_at.
          (b.start_time + (COALESCE(b.duration_minutes, 0)::int || ' minutes')::interval) AS end_time,
          b.status, b.charge_amount, b.booking_code,
          b.created_at,
          NULL::timestamptz AS updated_at
        FROM bookings b
        LEFT JOIN services  s  ON s.id  = b.service_id
        LEFT JOIN staff     st ON st.id = b.staff_id
        LEFT JOIN resources r  ON r.id  = b.resource_id
        WHERE b.tenant_id = $1
          AND b.customer_id = $2
          AND b.deleted_at IS NULL
          ${whereStatus}
        ORDER BY b.start_time DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `;

      const result = await db.query(q, params);

      // Total count (same filters, no pagination) — for "hasMore" UI
      const countParams = [tenantId, customerId];
      let countWhere = "";
      if (statusFilter) {
        countParams.push(statusFilter);
        countWhere = ` AND status = $${countParams.length}`;
      }
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS total
           FROM bookings
          WHERE tenant_id = $1
            AND customer_id = $2
            AND deleted_at IS NULL
            ${countWhere}`,
        countParams
      );
      const total = Number(countRes.rows[0]?.total || 0);
      const hasMore = offset + result.rows.length < total;

      return res.json({
        bookings: result.rows,
        total,
        limit,
        offset,
        hasMore,
      });
    } catch (err) {
      console.error("GET /customers/:customerId/bookings error:", err?.message);
      return res.status(500).json({ error: "Failed to load customer bookings." });
    }
  }
);

};
