// routes/bookings.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { requireTenant } = require("../middleware/requireTenant");
const { checkConflicts, loadJoinedBookingById } = require("../utils/bookings");

// ---------------------------------------------------------------------------
// GET /api/bookings?tenantSlug|tenantId=
//
// Filters/pagination (owner bookings tab):
// - from=YYYY-MM-DD
// - to=YYYY-MM-DD
// - status=pending|confirmed|cancelled|completed|all
// - query=customer partial match (name/phone/email)
// - serviceId=
// - resourceId=
// - customerId=
// - limit= (default 25)
// - offset= (default 0)
// - view=upcoming|past|all  (default upcoming)
//
// Tenant isolation via requireTenant.
// ---------------------------------------------------------------------------
router.get("/", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const view = String(req.query.view || "upcoming");
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    const status = String(req.query.status || "all");
    const query = String(req.query.query || "").trim();
    const serviceId = req.query.serviceId ? Number(req.query.serviceId) : null;
    const resourceId = req.query.resourceId ? Number(req.query.resourceId) : null;
    const customerId = req.query.customerId ? Number(req.query.customerId) : null;

    const limitRaw = req.query.limit ? Number(req.query.limit) : 25;
    const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 25));
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

    const params = [tenantId];
    const where = [`b.tenant_id = $1`];

    // default upcoming (today+)
    if (view === "upcoming") {
      where.push(`b.start_time >= NOW()`);
    } else if (view === "past") {
      where.push(`b.start_time < NOW()`);
    }

    // date range filters (optional)
    if (from) {
      params.push(`${from}T00:00:00.000Z`);
      where.push(`b.start_time >= $${params.length}::timestamptz`);
    }
    if (to) {
      // inclusive end of day
      params.push(`${to}T23:59:59.999Z`);
      where.push(`b.start_time <= $${params.length}::timestamptz`);
    }

    // status filter
    if (status && status !== "all") {
      params.push(status);
      where.push(`b.status = $${params.length}`);
    }

    // customerId filter (used by public history)
    if (customerId) {
      params.push(customerId);
      where.push(`b.customer_id = $${params.length}`);
    }

    // query filter (name/phone/email)
    if (query) {
      params.push(`%${query}%`);
      const i = params.length;
      where.push(`(
        b.customer_name ILIKE $${i}
        OR COALESCE(b.customer_phone,'') ILIKE $${i}
        OR COALESCE(b.customer_email,'') ILIKE $${i}
      )`);
    }

    if (serviceId) {
      params.push(serviceId);
      where.push(`b.service_id = $${params.length}`);
    }

    if (resourceId) {
      params.push(resourceId);
      where.push(`b.resource_id = $${params.length}`);
    }

    const order =
      view === "past" ? `ORDER BY b.start_time DESC` : `ORDER BY b.start_time ASC`;

    params.push(limit);
    params.push(offset);

    const q = `
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
        b.customer_name,
        b.customer_phone,
        b.customer_email,
        b.status,
        b.booking_code
      FROM bookings b
      JOIN tenants t ON b.tenant_id = t.id
      LEFT JOIN services  s  ON b.service_id  = s.id
      LEFT JOIN staff     st ON b.staff_id    = st.id
      LEFT JOIN resources r  ON b.resource_id = r.id
      WHERE ${where.join(" AND ")}
      ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const result = await db.query(q, params);

    return res.json({
      bookings: result.rows,
      limit,
      offset,
      nextOffset: result.rows.length < limit ? null : offset + limit,
    });
  } catch (err) {
    console.error("Error loading bookings:", err);
    return res.status(500).json({ error: "Failed to load bookings" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/bookings/:id?tenantSlug|tenantId=
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

    const joined = await loadJoinedBookingById(bookingId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error loading booking:", err);
    return res.status(500).json({ error: "Failed to load booking" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/bookings/:id/status?tenantSlug|tenantId=
// Body: { status: "pending"|"confirmed"|"cancelled"|"completed" }
//
// NOTE: Your owner UI currently uses POST here, so we provide POST alias too.
// ---------------------------------------------------------------------------
async function handleStatusChange(req, res) {
  try {
    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);
    const { status } = req.body || {};

    const allowed = new Set(["pending", "confirmed", "cancelled", "completed"]);
    if (!allowed.has(String(status))) {
      return res.status(400).json({ error: "Invalid status." });
    }
    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    const upd = await db.query(
      `UPDATE bookings
       SET status=$1
       WHERE id=$2 AND tenant_id=$3
       RETURNING id`,
      [String(status), bookingId, tenantId]
    );

    if (!upd.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const joined = await loadJoinedBookingById(bookingId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error updating booking status:", err);
    return res.status(500).json({ error: "Failed to update booking status." });
  }
}

router.patch("/:id/status", requireTenant, handleStatusChange);
router.post("/:id/status", requireTenant, handleStatusChange);

// ---------------------------------------------------------------------------
// DELETE /api/bookings/:id?tenantSlug|tenantId=
// Soft-cancel (does NOT hard delete rows)
// ---------------------------------------------------------------------------
router.delete("/:id", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    const upd = await db.query(
      `UPDATE bookings
       SET status='cancelled'
       WHERE id=$1 AND tenant_id=$2
       RETURNING id`,
      [bookingId, tenantId]
    );

    if (!upd.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const joined = await loadJoinedBookingById(bookingId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error cancelling booking:", err);
    return res.status(500).json({ error: "Failed to cancel booking." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bookings
//
// Validates:
// - duration aligns to service.slot_interval_minutes
// - duration >= minSlots*interval
// - duration <= max_consecutive_slots*interval
// - capacity respects max_parallel_bookings
//
// Tenant resolved server-side via tenantSlug/tenantId in body (unchanged).
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId,
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

    if (!customerName || !String(customerName).trim() || !startTime) {
      return res
        .status(400)
        .json({ error: "Missing required fields (customerName, startTime)." });
    }

    // Resolve tenant
    let resolvedTenantId = null;
    if (tenantSlug) {
      const tRes = await db.query(
        `SELECT id FROM tenants WHERE slug=$1 LIMIT 1`,
        [String(tenantSlug)]
      );
      resolvedTenantId = tRes.rows?.[0]?.id || null;
      if (!resolvedTenantId)
        return res.status(400).json({ error: "Unknown tenantSlug." });

      if (
        tenantId != null &&
        String(tenantId).trim() !== "" &&
        Number(tenantId) !== Number(resolvedTenantId)
      ) {
        return res.status(400).json({ error: "Tenant mismatch." });
      }
    } else if (tenantId != null && String(tenantId).trim() !== "") {
      const tid = Number(tenantId);
      if (!Number.isFinite(tid) || tid <= 0)
        return res.status(400).json({ error: "Invalid tenantId." });
      resolvedTenantId = tid;
    }

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime." });
    }

    // Validate service belongs to tenant + load rules
    const resolvedServiceId = serviceId ? Number(serviceId) : null;
    if (!resolvedServiceId) {
      return res.status(400).json({ error: "serviceId is required." });
    }

    const sRes = await db.query(
      `
      SELECT
        id,
        tenant_id,
        duration_minutes,
        slot_interval_minutes,
        max_consecutive_slots,
        max_parallel_bookings,
        requires_staff,
        requires_resource
      FROM services
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1
      `,
      [resolvedServiceId, resolvedTenantId]
    );

    if (!sRes.rows.length) {
      return res.status(400).json({ error: "Unknown serviceId for tenant." });
    }

    const svc = sRes.rows[0];
    const minDuration = Number(svc.duration_minutes || 60) || 60;
    const interval = Number(svc.slot_interval_minutes || 60) || 60;
    const maxSlots = Number(svc.max_consecutive_slots || 0) || Math.max(1, Math.ceil(minDuration / interval));
    const maxParallel = Number(svc.max_parallel_bookings || 1) || 1;

    const requiresStaff = Boolean(svc.requires_staff);
    const requiresResource = Boolean(svc.requires_resource);

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    if (requiresStaff && !staff_id) {
      return res.status(400).json({ error: "This service requires staffId." });
    }
    if (requiresResource && !resource_id) {
      return res.status(400).json({ error: "This service requires resourceId." });
    }

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
        return res.status(400).json({ error: "resourceId not valid for tenant." });
    }

    // Duration validation (service-driven)
    const dur = Number(durationMinutes);
    if (!Number.isFinite(dur) || dur <= 0) {
      return res.status(400).json({ error: "durationMinutes is required." });
    }

    if (dur % interval !== 0) {
      return res.status(400).json({ error: `durationMinutes must be a multiple of ${interval}.` });
    }

    const minSlots = Math.max(1, Math.ceil(minDuration / interval));
    const minAllowed = minSlots * interval;
    const maxAllowed = maxSlots * interval;

    if (dur < minAllowed) {
      return res.status(400).json({ error: `Minimum booking is ${minAllowed} minutes (${minSlots} slots).` });
    }
    if (dur > maxAllowed) {
      return res.status(400).json({ error: `Maximum booking is ${maxAllowed} minutes (${maxSlots} slots).` });
    }

    // Capacity enforcement:
    // If resource is selected, capacity is effectively 1 for that resource.
    // Otherwise enforce service-level max_parallel_bookings per service.
    const capacity = resource_id ? 1 : maxParallel;

    // Count overlapping bookings in blocking statuses for the same scope
    // (tenant + [resource if present] + service_id)
    const blockingStatuses = ["pending", "confirmed"];
    const newEnd = new Date(start.getTime() + dur * 60_000);

    const params = [resolvedTenantId, blockingStatuses, resolvedServiceId, start.toISOString(), newEnd.toISOString()];
    const where = [
      `b.tenant_id = $1`,
      `b.status = ANY($2)`,
      `b.service_id = $3`,
      `b.start_time < $5::timestamptz`,
      `(b.start_time + (b.duration_minutes::int || ' minutes')::interval) > $4::timestamptz`,
    ];

    if (resource_id) {
      params.push(resource_id);
      where.push(`b.resource_id = $${params.length}`);
    }

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS c FROM bookings b WHERE ${where.join(" AND ")}`,
      params
    );

    const c = Number(countRes.rows?.[0]?.c || 0) || 0;
    if (c >= capacity) {
      return res.status(409).json({ error: "No capacity for that time range." });
    }

    // Staff/resource conflicts (still useful if staff/resource selected)
    // (this keeps your existing behavior)
    const conflicts = await checkConflicts({
      tenantId: resolvedTenantId,
      staffId: staff_id,
      resourceId: resource_id,
      startTime: start.toISOString(),
      durationMinutes: dur,
    });

    if (conflicts.conflict && (staff_id || resource_id)) {
      return res.status(409).json({
        error: "Booking conflicts with an existing booking.",
        conflicts,
      });
    }

    // Upsert customer within tenant
    const cleanName = String(customerName).trim();
    const cleanPhone = customerPhone ? String(customerPhone).trim() : null;
    const cleanEmail = customerEmail ? String(customerEmail).trim() : null;

    let finalCustomerId = null;

    if (customerId) {
      const cid = Number(customerId);
      const cRes = await db.query(
        `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2`,
        [cid, resolvedTenantId]
      );
      if (cRes.rows.length) finalCustomerId = cRes.rows[0].id;
    }

    if (!finalCustomerId && (cleanPhone || cleanEmail)) {
      const existingRes = await db.query(
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
          await db.query(
            `UPDATE customers SET name=$1, updated_at=NOW() WHERE id=$2`,
            [cleanName, finalCustomerId]
          );
        }
      } else {
        const insertCust = await db.query(
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

    // Insert booking
    const insert = await db.query(
      `
      INSERT INTO bookings
        (tenant_id, service_id, staff_id, resource_id, start_time, duration_minutes,
         customer_id, customer_name, customer_phone, customer_email, status)
      VALUES
        ($1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, 'pending')
      RETURNING id;
      `,
      [
        resolvedTenantId,
        resolvedServiceId,
        staff_id,
        resource_id,
        start.toISOString(),
        dur,
        finalCustomerId,
        cleanName,
        cleanPhone,
        cleanEmail,
      ]
    );

    const bookingId = insert.rows[0].id;

    const firstLetter = cleanName.charAt(0).toUpperCase() || "X";
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const bookingCode = `${firstLetter}-${resolvedTenantId}-${resolvedServiceId}-${ymd}-${bookingId}`;

    await db.query(`UPDATE bookings SET booking_code = $1 WHERE id = $2`, [
      bookingCode,
      bookingId,
    ]);

    const joined = await loadJoinedBookingById(bookingId);
    return res.status(201).json({ booking: joined });
  } catch (err) {
    console.error("Error creating booking:", err);
    return res
      .status(500)
      .json({ error: "Failed to create booking.", details: String(err) });
  }
});

module.exports = router;
