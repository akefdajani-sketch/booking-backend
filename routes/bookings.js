// routes/bookings.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { requireTenant } = require("../middleware/requireTenant");
const { checkConflicts, loadJoinedBookingById } = require("../utils/bookings");

// ---------------------------------------------------------------------------
// GET /api/bookings?tenantSlug|tenantId=
// P1: tenant is REQUIRED (no "return all bookings").
// ---------------------------------------------------------------------------
router.get("/", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;

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
      WHERE b.tenant_id = $1
      ORDER BY b.start_time DESC
    `;

    const result = await db.query(q, [tenantId]);
    return res.json({ bookings: result.rows });
  } catch (err) {
    console.error("Error loading bookings:", err);
    return res.status(500).json({ error: "Failed to load bookings" });
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
// Tenant-scoped status change
// ---------------------------------------------------------------------------
router.patch("/:id/status", requireTenant, async (req, res) => {
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
});

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
// P1: tenant resolved server-side; service/staff/resource validated for tenant.
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

    // Resolve tenant using the same logic as requireTenant (but for body)
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

    if (conflicts.staffConflict || conflicts.resourceConflict) {
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
        duration,
        finalCustomerId,
        cleanName,
        cleanPhone,
        cleanEmail,
      ]
    );

    const bookingId = insert.rows[0].id;

    const firstLetter = cleanName.charAt(0).toUpperCase() || "X";
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const bookingCode = `${firstLetter}-${resolvedTenantId}-${resolvedServiceId || 0}-${ymd}-${bookingId}`;

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
