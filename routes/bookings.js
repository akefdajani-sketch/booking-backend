// routes/bookings.js
const express = require("express");
const router = express.Router();

const { pool } = require("../db");

// If you already split helpers into utils, keep these requires.
// (If you haven’t created them yet, tell me and I’ll generate them too.)
const { getTenantIdFromSlug } = require("../utils/tenants");
const { checkConflicts, loadJoinedBookingById } = require("../utils/bookings");

// ---------------------------------------------------------------------------
// GET /api/bookings?tenantId=&tenantSlug=
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { tenantId, tenantSlug } = req.query;
    let resolvedTenantId = tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenant." });
      }
    }

    const params = [];
    let where = "";
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      where = "WHERE b.tenant_id = $1";
    }

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
      ${where}
      ORDER BY b.start_time DESC
    `;

    const result = await db.query(q, params);
    return res.json({ bookings: result.rows });
  } catch (err) {
    console.error("Error loading bookings:", err);
    return res.status(500).json({ error: "Failed to load bookings" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bookings
// Flexible endpoint used by both owner + public pages
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
      customerId, // optional existing customer id
    } = req.body || {};

    if (!customerName || !customerName.trim() || !startTime) {
      return res.status(400).json({
        error: "Missing required fields (customerName, startTime).",
      });
    }

    let resolvedTenantId = tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenantSlug." });
      }
    }

    let resolvedServiceId = serviceId ? Number(serviceId) : null;
    let duration = durationMinutes ? Number(durationMinutes) : null;

    // If serviceId is provided, validate it and derive tenant/duration if needed
    if (resolvedServiceId) {
      const sRes = await db.query("SELECT * FROM services WHERE id = $1", [
        resolvedServiceId,
      ]);
      if (sRes.rows.length === 0) {
        return res.status(400).json({ error: "Unknown serviceId." });
      }

      const s = sRes.rows[0];

      if (resolvedTenantId && s.tenant_id !== resolvedTenantId) {
        return res
          .status(400)
          .json({ error: "Service does not belong to this tenant." });
      }

      if (!resolvedTenantId) {
        resolvedTenantId = s.tenant_id;
      }

      // if duration not provided, default to service duration
      if (!duration) {
        duration =
          s.duration_minutes && Number(s.duration_minutes) > 0
            ? Number(s.duration_minutes)
            : 60;
      }
    }

    if (!resolvedTenantId) {
      return res.status(400).json({
        error: "You must provide tenantSlug or tenantId or serviceId.",
      });
    }

    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime." });
    }
    if (!duration) duration = 60;

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    // 1) Conflicts
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

    // 2) Resolve / upsert customer_id
    const cleanName = customerName.trim();
    const cleanPhone =
      typeof customerPhone === "string" && customerPhone.trim().length
        ? customerPhone.trim()
        : null;
    const cleanEmail =
      typeof customerEmail === "string" && customerEmail.trim().length
        ? customerEmail.trim()
        : null;

    let finalCustomerId = null;

    // 2a) If explicit customerId, verify tenant
    if (customerId) {
      const cid = Number(customerId);
      const cRes = await db.query(
        `
        SELECT id
        FROM customers
        WHERE id = $1 AND tenant_id = $2
        `,
        [cid, resolvedTenantId]
      );
      if (cRes.rows.length > 0) finalCustomerId = cRes.rows[0].id;
    }

    // 2b) If no valid customerId yet but we have phone/email, upsert
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

      if (existingRes.rows.length > 0) {
        finalCustomerId = existingRes.rows[0].id;

        // update name if changed
        if (cleanName && cleanName !== existingRes.rows[0].name) {
          await db.query(
            `
            UPDATE customers
            SET name = $1, updated_at = NOW()
            WHERE id = $2
            `,
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

    // 3) Insert booking
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

    // Generate booking_code (first-letter-tenant-service-date-bookingId)
    const firstLetter = (customerName || "X").trim().charAt(0).toUpperCase() || "X";
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const bookingCode = `${firstLetter}-${resolvedTenantId || 0}-${resolvedServiceId || 0}-${ymd}-${bookingId}`;

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

// ---------------------------------------------------------------------------
// DELETE /api/bookings/:id
// Cancel (soft-delete) a booking
// - Customer cancels by matching customerEmail to bookings.customer_email
// - Owner cancels with x-owner-token (set BOOKFLOW_OWNER_TOKEN on Render)
// ---------------------------------------------------------------------------
router.delete("/:id", async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).send("Invalid booking id");
    }

    // Accept params in body OR query (useful when some clients can't send DELETE bodies)
    const tenantSlug = req.body?.tenantSlug ?? req.query?.tenantSlug;
    const role = (req.body?.role ?? req.query?.role ?? "customer").toString(); // "customer" | "owner"
    const customerEmailRaw = req.body?.customerEmail ?? req.query?.customerEmail;
    const customerEmail = customerEmailRaw
      ? String(customerEmailRaw).trim().toLowerCase()
      : null;

    if (!tenantSlug) return res.status(400).send("tenantSlug is required");

    const tenantId = await getTenantIdFromSlug(String(tenantSlug));
    if (!tenantId) return res.status(400).send("Unknown tenantSlug");

    // Load booking
    const check = await db.query(
      `
      SELECT id, tenant_id, status, customer_email
      FROM bookings
      WHERE id = $1 AND tenant_id = $2
      `,
      [bookingId, tenantId]
    );

    if (check.rows.length === 0) return res.status(404).send("Booking not found");

    const row = check.rows[0];
    const bookingEmail = row.customer_email
      ? String(row.customer_email).trim().toLowerCase()
      : null;

    // Idempotent: already cancelled => OK
    if (String(row.status).toLowerCase() === "cancelled") {
      return res.json({ ok: true, alreadyCancelled: true });
    }

    // Role-based authorization
    if (role === "owner") {
      const ownerToken = req.headers["x-owner-token"];
      const expected = process.env.BOOKFLOW_OWNER_TOKEN;

      // If BOOKFLOW_OWNER_TOKEN is set, enforce it
      if (expected && String(ownerToken) !== String(expected)) {
        return res.status(401).send("Invalid owner token");
      }
    } else {
      // customer
      if (!customerEmail) return res.status(400).send("customerEmail is required");
      if (!bookingEmail || bookingEmail !== customerEmail) {
        return res.status(403).send("Not allowed");
      }
    }

    // Cancel booking
    const upd = await db.query(
      `
      UPDATE bookings
      SET status = 'cancelled'
      WHERE id = $1 AND tenant_id = $2
      RETURNING id
      `,
      [bookingId, tenantId]
    );

    if (upd.rows.length === 0) return res.status(404).send("Booking not found");
    return res.json({ ok: true, cancelled: true });
  } catch (err) {
    console.error("Error cancelling booking:", err);
    return res.status(500).send("Failed to cancel booking");
  }
});

module.exports = router;
