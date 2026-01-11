// routes/bookings.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { requireTenant } = require("../middleware/requireTenant");
const { checkConflicts, loadJoinedBookingById } = require("../utils/bookings");

// ---------------------------------------------------------------------------
// Phase 0 safety helpers
// ---------------------------------------------------------------------------
function getIdempotencyKey(req) {
  const headerKey = req.get("Idempotency-Key") || req.get("idempotency-key");
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  const raw = headerKey || bodyKey;
  const key = raw ? String(raw).trim() : "";
  // keep it simple; DB constraint + uniqueness does the heavy lifting
  return key || null;
}

function mustHaveTenantSlug(req, res) {
  const slug = (req.query?.tenantSlug ?? req.body?.tenantSlug ?? "")
    .toString()
    .trim();
  if (!slug) {
    res.status(400).json({ error: "tenantSlug is required." });
    return null;
  }
  return slug;
}

function canTransitionStatus(fromStatus, toStatus) {
  const from = String(fromStatus || "").toLowerCase();
  const to = String(toStatus || "").toLowerCase();
  if (!from || !to) return false;
  if (from === to) return true; // idempotent

  const allowed = {
    pending: new Set(["confirmed", "cancelled"]),
    confirmed: new Set(["cancelled"]),
    cancelled: new Set([]),
  };
  return Boolean(allowed[from] && allowed[from].has(to));
}

// ---------------------------------------------------------------------------
// GET /api/bookings?tenantSlug|tenantId=...
//
// SaaS-ready list endpoint:
// - Defaults to upcoming bookings (start_time >= now) ordered ASC
// - Supports scope: upcoming | past | range (or legacy: view=upcoming|past|all)
// - Supports filters: from, to, status, serviceId, staffId, resourceId, customerId
// - Supports search: query (matches booking_code + customer fields)
// - Uses keyset (cursor) pagination: cursorStartTime + cursorId
//
// Response: { bookings: [...], nextCursor: { start_time, id } | null }
// ---------------------------------------------------------------------------
router.get("/", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // ---- parse params ----
    const scopeRaw =
      (req.query.scope ? String(req.query.scope) : "") ||
      (req.query.view ? String(req.query.view) : "");
    const scope = (scopeRaw || "upcoming").toLowerCase(); // upcoming|past|range|all

    const status = req.query.status ? String(req.query.status).trim() : null;

    const serviceId = req.query.serviceId ? Number(req.query.serviceId) : null;
    const staffId = req.query.staffId ? Number(req.query.staffId) : null;
    const resourceId = req.query.resourceId ? Number(req.query.resourceId) : null;
    const customerId = req.query.customerId ? Number(req.query.customerId) : null;

    const query = req.query.query ? String(req.query.query).trim() : "";

    const limitRaw = req.query.limit ? Number(req.query.limit) : 50;
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));

    const cursorStartTime = req.query.cursorStartTime
      ? new Date(String(req.query.cursorStartTime))
      : null;
    const cursorId = req.query.cursorId ? Number(req.query.cursorId) : null;

    if (cursorStartTime && Number.isNaN(cursorStartTime.getTime())) {
      return res.status(400).json({ error: "Invalid cursorStartTime." });
    }
    if (cursorId != null && (!Number.isFinite(cursorId) || cursorId <= 0)) {
      return res.status(400).json({ error: "Invalid cursorId." });
    }

    // from/to
    const fromTs = req.query.from ? new Date(String(req.query.from)) : null;
    const toTs = req.query.to ? new Date(String(req.query.to)) : null;

    if (fromTs && Number.isNaN(fromTs.getTime())) return res.status(400).json({ error: "Invalid from." });
    if (toTs && Number.isNaN(toTs.getTime())) return res.status(400).json({ error: "Invalid to." });

    // ---- build WHERE ----
    const params = [tenantId];
    const where = ["b.tenant_id = $1"];

    // scope defaults
    if (scope === "upcoming") {
      where.push(`b.start_time >= NOW()`);
    } else if (scope === "past") {
      where.push(`b.start_time < NOW()`);
    } else if (scope === "range") {
      // rely on from/to
    } else if (scope === "all") {
      // no implicit time filter
    } else {
      // treat unknown scope as upcoming
      where.push(`b.start_time >= NOW()`);
    }

    if (fromTs) {
      params.push(fromTs.toISOString());
      where.push(`b.start_time >= $${params.length}`);
    }
    if (toTs) {
      params.push(toTs.toISOString());
      where.push(`b.start_time < $${params.length}`);
    }

    if (status && status !== "all") {
      params.push(status);
      where.push(`b.status = $${params.length}`);
    }

    if (Number.isFinite(serviceId) && serviceId > 0) {
      params.push(serviceId);
      where.push(`b.service_id = $${params.length}`);
    }
    if (Number.isFinite(staffId) && staffId > 0) {
      params.push(staffId);
      where.push(`b.staff_id = $${params.length}`);
    }
    if (Number.isFinite(resourceId) && resourceId > 0) {
      params.push(resourceId);
      where.push(`b.resource_id = $${params.length}`);
    }
    if (Number.isFinite(customerId) && customerId > 0) {
      params.push(customerId);
      where.push(`b.customer_id = $${params.length}`);
    }

    // Search (booking_code + customer fields). Uses LEFT JOIN customers.
    if (query) {
      params.push(`%${query}%`);
      const p = `$${params.length}`;
      where.push(
        `(
          b.booking_code ILIKE ${p}
          OR b.customer_name ILIKE ${p}
          OR b.customer_phone ILIKE ${p}
          OR b.customer_email ILIKE ${p}
          OR c.name ILIKE ${p}
          OR c.phone ILIKE ${p}
          OR c.email ILIKE ${p}
        )`
      );
    }

    // ---- order + keyset cursor ----
    const isPast = scope === "past";
    const orderDir = isPast ? "DESC" : "ASC";
    const comparator = isPast ? "<" : ">";

    if (cursorStartTime && cursorId) {
      params.push(cursorStartTime.toISOString());
      const pStart = `$${params.length}`;
      params.push(cursorId);
      const pId = `$${params.length}`;
      where.push(`(b.start_time, b.id) ${comparator} (${pStart}, ${pId})`);
    }

    // ---- query ----
    const sql = `
      SELECT
        b.id,
        b.tenant_id,
        t.slug          AS tenant_slug,
        t.name          AS tenant,
        b.service_id,
        s.name          AS service_name,
        b.staff_id,
        st.name         AS staff_name,
        b.resource_id,
        r.name          AS resource_name,
        b.start_time,
        b.duration_minutes,

        b.customer_id,
        COALESCE(c.name, b.customer_name)   AS customer_name,
        COALESCE(c.phone, b.customer_phone) AS customer_phone,
        COALESCE(c.email, b.customer_email) AS customer_email,

        b.status,
        b.booking_code,
        b.created_at
      FROM bookings b
      JOIN tenants t ON b.tenant_id = t.id
      LEFT JOIN customers c
        ON c.tenant_id = b.tenant_id AND c.id = b.customer_id
      LEFT JOIN services s
        ON s.tenant_id = b.tenant_id AND s.id = b.service_id
      LEFT JOIN staff st
        ON st.tenant_id = b.tenant_id AND st.id = b.staff_id
      LEFT JOIN resources r
        ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
      WHERE ${where.join(" AND ")}
      ORDER BY b.start_time ${orderDir}, b.id ${orderDir}
      LIMIT $${params.length + 1}
    `;

    const result = await db.query(sql, [...params, limit]);

    const rows = result.rows || [];
    const last = rows.length ? rows[rows.length - 1] : null;

    return res.json({
      bookings: rows,
      nextCursor: last ? { start_time: last.start_time, id: last.id } : null,
    });
  } catch (err) {
    console.error("Error loading bookings:", err);
    return res.status(500).json({ error: "Failed to load bookings" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/bookings/count?tenantSlug|tenantId=...
// Fast count endpoint for UI "X results" without returning rows.
// Supports filters similar to list endpoint (no cursor).
//
// Query:
//   scope/view: upcoming|past|range|all
//   from, to
//   status
//   serviceId, staffId, resourceId, customerId
//   query (matches booking_code + booking/customer fields)
// ---------------------------------------------------------------------------
router.get("/count", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const scopeRaw =
      (req.query.scope ? String(req.query.scope) : "") ||
      (req.query.view ? String(req.query.view) : "");
    const scope = (scopeRaw || "upcoming").toLowerCase();

    const status = req.query.status ? String(req.query.status).trim() : null;

    const serviceId = req.query.serviceId ? Number(req.query.serviceId) : null;
    const staffId = req.query.staffId ? Number(req.query.staffId) : null;
    const resourceId = req.query.resourceId ? Number(req.query.resourceId) : null;
    const customerId = req.query.customerId ? Number(req.query.customerId) : null;

    const query = req.query.query ? String(req.query.query).trim() : "";

    const fromTs = req.query.from ? new Date(String(req.query.from)) : null;
    const toTs = req.query.to ? new Date(String(req.query.to)) : null;

    if (fromTs && Number.isNaN(fromTs.getTime())) return res.status(400).json({ error: "Invalid from." });
    if (toTs && Number.isNaN(toTs.getTime())) return res.status(400).json({ error: "Invalid to." });

    const params = [tenantId];
    const where = ["b.tenant_id = $1"];

    if (scope === "upcoming") where.push("b.start_time >= NOW()");
    else if (scope === "past") where.push("b.start_time < NOW()");
    else if (scope === "range") { /* rely on from/to */ }
    else if (scope === "all") { /* no implicit time filter */ }
    else where.push("b.start_time >= NOW()");

    if (fromTs) {
      params.push(fromTs.toISOString());
      where.push(`b.start_time >= $${params.length}`);
    }
    if (toTs) {
      params.push(toTs.toISOString());
      where.push(`b.start_time < $${params.length}`);
    }

    if (status && status !== "all") {
      params.push(status);
      where.push(`b.status = $${params.length}`);
    }

    if (Number.isFinite(serviceId) && serviceId > 0) {
      params.push(serviceId);
      where.push(`b.service_id = $${params.length}`);
    }
    if (Number.isFinite(staffId) && staffId > 0) {
      params.push(staffId);
      where.push(`b.staff_id = $${params.length}`);
    }
    if (Number.isFinite(resourceId) && resourceId > 0) {
      params.push(resourceId);
      where.push(`b.resource_id = $${params.length}`);
    }
    if (Number.isFinite(customerId) && customerId > 0) {
      params.push(customerId);
      where.push(`b.customer_id = $${params.length}`);
    }

    const joinCustomers = Boolean(query);
    if (query) {
      params.push(`%${query}%`);
      const p = `$${params.length}`;
      where.push(
        `(
          b.booking_code ILIKE ${p}
          OR b.customer_name ILIKE ${p}
          OR b.customer_phone ILIKE ${p}
          OR b.customer_email ILIKE ${p}
          OR c.name ILIKE ${p}
          OR c.phone ILIKE ${p}
          OR c.email ILIKE ${p}
        )`
      );
    }

    const sql = `
      SELECT COUNT(*)::int AS total
      FROM bookings b
      ${joinCustomers ? "LEFT JOIN customers c ON c.tenant_id=b.tenant_id AND c.id=b.customer_id" : ""}
      WHERE ${where.join(" AND ")}
    `;

    const result = await db.query(sql, params);
    return res.json({ total: result.rows?.[0]?.total ?? 0 });
  } catch (err) {
    console.error("Error counting bookings:", err);
    return res.status(500).json({ error: "Failed to count bookings" });
  }
});


// ---------------------------------------------------------------------------
// GET /api/bookings/:id?tenantSlug|tenantId=
// Tenant-scoped read (used by dashboards / detail views)
// ---------------------------------------------------------------------------
router.get("/:id", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    const result = await db.query(
      `SELECT id FROM bookings WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [bookingId, tenantId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const joined = await loadJoinedBookingById(bookingId, tenantId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error loading booking:", err);
    return res.status(500).json({ error: "Failed to load booking" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/bookings/:id/status?tenantSlug|tenantId=
// Body: { status: "pending"|"confirmed"|"cancelled"|"completed" }
// Tenant-scoped status change
// ---------------------------------------------------------------------------
router.patch("/:id/status", requireTenant, async (req, res) => {
  try {
    // Phase 0: do not allow tenantId-only writes on status mutations
    if (!mustHaveTenantSlug(req, res)) return;

    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);
    const { status } = req.body || {};

    const allowed = new Set(["pending", "confirmed", "cancelled"]);
    const nextStatus = String(status || "").toLowerCase();
    if (!allowed.has(nextStatus)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    // Load current status for transition validation
    const curRes = await db.query(
      `SELECT status FROM bookings WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [bookingId, tenantId]
    );
    if (!curRes.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const currentStatus = String(curRes.rows[0].status || "").toLowerCase();
    if (!canTransitionStatus(currentStatus, nextStatus)) {
      return res.status(409).json({
        error: `Invalid status transition: ${currentStatus} → ${nextStatus}`,
      });
    }

    // Idempotent no-op
    if (currentStatus === nextStatus) {
      const joined = await loadJoinedBookingById(bookingId, tenantId);
      return res.json({ booking: joined });
    }

    const upd = await db.query(
      `UPDATE bookings
       SET status=$1
       WHERE id=$2 AND tenant_id=$3
       RETURNING id`,
      [nextStatus, bookingId, tenantId]
    );

    if (!upd.rows.length) return res.status(404).json({ error: "Booking not found." });

    const joined = await loadJoinedBookingById(bookingId, tenantId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error updating booking status:", err);
    return res.status(500).json({ error: "Failed to update booking status." });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/bookings/:id?tenantSlug|tenantId=
// Soft-cancel (does NOT hard delete rows)
// ---------------------------------------------------------------------------
router.delete("/:id", requireTenant, async (req, res) => {
  try {
    // Phase 0: do not allow tenantId-only writes on cancellation
    if (!mustHaveTenantSlug(req, res)) return;

    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    // Load current status for transition validation
    const curRes = await db.query(
      `SELECT status FROM bookings WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [bookingId, tenantId]
    );
    if (!curRes.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const currentStatus = String(curRes.rows[0].status || "").toLowerCase();
    const nextStatus = "cancelled";

    if (!canTransitionStatus(currentStatus, nextStatus)) {
      return res.status(409).json({
        error: `Invalid status transition: ${currentStatus} → ${nextStatus}`,
      });
    }

    // Idempotent no-op
    if (currentStatus !== nextStatus) {
      await db.query(
        `UPDATE bookings
         SET status='cancelled'
         WHERE id=$1 AND tenant_id=$2`,
        [bookingId, tenantId]
      );
    }

    const joined = await loadJoinedBookingById(bookingId, tenantId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error cancelling booking:", err);
    return res.status(500).json({ error: "Failed to cancel booking." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bookings
// P1: tenant resolved server-side; service/staff/resource validated for tenant.
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const {
      tenantSlug,
      serviceId,
      startTime,
      durationMinutes,
      customerName,
      customerPhone,
      customerEmail,
      staffId,
      resourceId,
      customerId,
    } = req.body || {};

    // Phase 0: require tenantSlug for public booking creation.
    // We do not accept tenantId-only writes here.
    const slug = mustHaveTenantSlug(req, res);
    if (!slug) return;

    const idemKey = getIdempotencyKey(req);

    if (!customerName || !String(customerName).trim() || !startTime) {
      return res
        .status(400)
        .json({ error: "Missing required fields (customerName, startTime)." });
    }

    // Resolve tenant from slug (server-side) and optionally validate mismatch if tenantId was sent.
    const tRes = await db.query(
      `SELECT id FROM tenants WHERE slug=$1 LIMIT 1`,
      [String(slug)]
    );
    const resolvedTenantId = tRes.rows?.[0]?.id || null;
    if (!resolvedTenantId) return res.status(400).json({ error: "Unknown tenantSlug." });

    const tenantIdRaw = req.body?.tenantId;
    if (tenantIdRaw != null && String(tenantIdRaw).trim() !== "") {
      const tid = Number(tenantIdRaw);
      if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: "Invalid tenantId." });
      if (Number(tid) !== Number(resolvedTenantId)) {
        return res.status(400).json({ error: "Tenant mismatch." });
      }
    }

    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime." });
    }

    // Validate service belongs to tenant
    let resolvedServiceId = serviceId ? Number(serviceId) : null;
    let duration = durationMinutes ? Number(durationMinutes) : null;

    if (resolvedServiceId) {
      const sRes = await db.query(
        `SELECT id, tenant_id, duration_minutes FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [resolvedServiceId, resolvedTenantId]
      );
      if (!sRes.rows.length)
        return res.status(400).json({ error: "Unknown serviceId for tenant." });

      if (!duration) {
        duration = Number(sRes.rows[0].duration_minutes || 60) || 60;
      }
    } else {
      duration = duration || 60;
    }

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    // Validate staff/resource belong to tenant if provided
    if (staff_id) {
      const st = await db.query(
        `SELECT id FROM staff WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [staff_id, resolvedTenantId]
      );
      if (!st.rows.length)
        return res.status(400).json({ error: "staffId not valid for tenant." });
    }
    if (resource_id) {
      const rr = await db.query(
        `SELECT id FROM resources WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [resource_id, resolvedTenantId]
      );
      if (!rr.rows.length)
        return res
          .status(400)
          .json({ error: "resourceId not valid for tenant." });
    }

    // Conflicts
    const conflicts = await checkConflicts({
      tenantId: resolvedTenantId,
      staffId: staff_id,
      resourceId: resource_id,
      startTime: start.toISOString(),
      durationMinutes: duration,
    });

    // NOTE: checkConflicts returns { conflict: boolean, conflicts: [...] }
    // The old route logic expected staffConflict/resourceConflict, which meant
    // conflicts were never enforced and double-bookings could slip through.
    if (conflicts.conflict) {
      return res.status(409).json({
        error: "Booking conflicts with an existing booking.",
        conflicts,
      });
    }

    // Use a transaction so idempotency replays don't create partial side effects.
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Upsert customer within tenant
    const cleanName = String(customerName).trim();
    const cleanPhone = customerPhone ? String(customerPhone).trim() : null;
    const cleanEmail = customerEmail ? String(customerEmail).trim() : null;

    let finalCustomerId = null;

    if (customerId) {
      const cid = Number(customerId);
      const cRes = await client.query(
        `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2`,
        [cid, resolvedTenantId]
      );
      if (cRes.rows.length) finalCustomerId = cRes.rows[0].id;
    }

    if (!finalCustomerId && (cleanPhone || cleanEmail)) {
      const existingRes = await client.query(
        `
        SELECT id, name
        FROM customers
        WHERE tenant_id = $1
          AND (
            ($2::text IS NOT NULL AND phone = $2::text) OR
            ($3::text IS NOT NULL AND email = $3::text)
          )
        LIMIT 1
        `,
        [resolvedTenantId, cleanPhone, cleanEmail]
      );

      if (existingRes.rows.length) {
        finalCustomerId = existingRes.rows[0].id;
        if (cleanName && cleanName !== existingRes.rows[0].name) {
          await client.query(
            `UPDATE customers SET name=$1, updated_at=NOW() WHERE id=$2`,
            [cleanName, finalCustomerId]
          );
        }
      } else {
        const insertCust = await client.query(
          `
          INSERT INTO customers (tenant_id, name, phone, email, notes, created_at)
          VALUES ($1, $2, $3, $4, NULL, NOW())
          RETURNING id
          `,
          [resolvedTenantId, cleanName, cleanPhone, cleanEmail]
        );
        finalCustomerId = insertCust.rows[0].id;
      }
    }

    // Insert booking (idempotent)
    let bookingId;
    let created = true;
    try {
      const insert = await client.query(
        `
        INSERT INTO bookings
          (tenant_id, service_id, staff_id, resource_id, start_time, duration_minutes,
           customer_id, customer_name, customer_phone, customer_email, status, idempotency_key)
        VALUES
          ($1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, 'pending', $11)
        RETURNING id;
        `,
        [
          resolvedTenantId,
          resolvedServiceId,
          staff_id,
          resource_id,
          start.toISOString(),
          duration,
          finalCustomerId,
          cleanName,
          cleanPhone,
          cleanEmail,
          idemKey,
        ]
      );
      bookingId = insert.rows[0].id;
    } catch (err) {
      // If we get a unique violation on (tenant_id, idempotency_key), return the original booking.
      if (idemKey && err && err.code === "23505") {
        const existing = await client.query(
          `SELECT id FROM bookings WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1`,
          [resolvedTenantId, idemKey]
        );
        if (existing.rows.length) {
          bookingId = existing.rows[0].id;
          created = false;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const firstLetter = cleanName.charAt(0).toUpperCase() || "X";
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const bookingCode = `${firstLetter}-${resolvedTenantId}-${resolvedServiceId || 0}-${ymd}-${bookingId}`;

    // Only set booking_code if not already set (important for idempotent replays)
    await client.query(
      `UPDATE bookings
       SET booking_code = COALESCE(booking_code, $1)
       WHERE id = $2 AND tenant_id = $3`,
      [bookingCode, bookingId, resolvedTenantId]
    );

    await client.query("COMMIT");

    // Use the resolved tenantId (not the raw body tenantId which might be empty/mismatched)
    const joined = await loadJoinedBookingById(bookingId, resolvedTenantId);
    return res.status(created ? 201 : 200).json({ booking: joined, replay: !created });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error creating booking:", err);
    return res
      .status(500)
      .json({ error: "Failed to create booking.", details: String(err) });
  }
});

module.exports = router;
