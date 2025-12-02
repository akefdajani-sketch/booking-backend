const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json()); // allow JSON bodies

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Booking backend API is running" });
});

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

// List tenants (for owner UI / routing)
app.get("/api/tenants", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        id,
        slug,
        name,
        kind,
        timezone,
        created_at
      FROM tenants
      ORDER BY name;
      `
    );
    res.json({ tenants: result.rows });
  } catch (err) {
    console.error("Error loading tenants:", err);
    res.status(500).json({ error: "Failed to load tenants" });
  }
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

// Services from Postgres (optionally filtered by tenantSlug)
app.get("/api/services", async (req, res) => {
  try {
    const { tenantSlug } = req.query;

    const params = [];
    let where = "WHERE s.is_active = TRUE";

    if (tenantSlug) {
      params.push(tenantSlug);
      where += ` AND t.slug = $${params.length}`;
    }

    const result = await db.query(
      `
      SELECT
        s.id,
        t.id    AS tenant_id,
        t.slug  AS tenant_slug,
        t.name  AS tenant,
        s.name  AS name,
        s.duration_minutes,
        s.price_jd,
        s.requires_staff,
        s.requires_resource
      FROM services s
      JOIN tenants t ON s.tenant_id = t.id
      ${where}
      ORDER BY t.name, s.name;
      `,
      params
    );

    res.json({ services: result.rows });
  } catch (err) {
    console.error("Error querying services:", err);
    res.status(500).json({ error: "Failed to load services" });
  }
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/**
 * GET /api/staff
 * Optional: ?tenantSlug=birdie-golf
 */
app.get("/api/staff", async (req, res) => {
  try {
    const { tenantSlug } = req.query;

    const params = [];
    let where = "WHERE s.is_active = TRUE";

    if (tenantSlug) {
      params.push(tenantSlug);
      where += ` AND t.slug = $${params.length}`;
    }

    const result = await db.query(
      `
      SELECT
        s.id,
        s.tenant_id,
        t.slug  AS tenant_slug,
        t.name  AS tenant,
        s.name,
        s.role,
        s.is_active,
        s.created_at
      FROM staff s
      JOIN tenants t ON s.tenant_id = t.id
      ${where}
      ORDER BY t.name, s.name;
      `,
      params
    );

    res.json({ staff: result.rows });
  } catch (err) {
    console.error("Error loading staff:", err);
    res.status(500).json({ error: "Failed to load staff" });
  }
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/**
 * GET /api/resources
 * Optional: ?tenantSlug=birdie-golf
 */
app.get("/api/resources", async (req, res) => {
  try {
    const { tenantSlug } = req.query;

    const params = [];
    let where = "WHERE r.is_active = TRUE";

    if (tenantSlug) {
      params.push(tenantSlug);
      where += ` AND t.slug = $${params.length}`;
    }

    const result = await db.query(
      `
      SELECT
        r.id,
        r.tenant_id,
        t.slug  AS tenant_slug,
        t.name  AS tenant,
        r.name,
        r.type,
        r.is_active,
        r.created_at
      FROM resources r
      JOIN tenants t ON r.tenant_id = t.id
      ${where}
      ORDER BY t.name, r.name;
      `,
      params
    );

    res.json({ resources: result.rows });
  } catch (err) {
    console.error("Error loading resources:", err);
    res.status(500).json({ error: "Failed to load resources" });
  }
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

/**
 * Create a booking
 * POST /api/bookings
 *
 * New flexible body:
 *  {
 *    "tenantSlug": "birdie-golf",           // preferred
 *    "serviceId": 1,                        // optional for manual bookings
 *    "staffId": 3,                          // optional; required if service.requires_staff
 *    "resourceId": 5,                       // optional; required if service.requires_resource
 *    "startTime": "2025-12-05T18:00:00Z",
 *    "durationMinutes": 60,                 // optional; falls back to service/default
 *    "customerName": "Akef",
 *    "customerPhone": "+962...",
 *    "customerEmail": "you@example.com"
 *  }
 *
 * Backwards-compatible mode (old style):
 *  {
 *    "serviceId": 1,
 *    "startTime": "...",
 *    "customerName": "..."
 *  }
 */
app.post("/api/bookings", async (req, res) => {
  try {
    const {
      tenantSlug,
      serviceId,
      staffId,
      resourceId,
      startTime,
      durationMinutes,
      customerName,
      customerPhone,
      customerEmail,
    } = req.body;

    // Basic validation
    if (!customerName || !startTime) {
      return res
        .status(400)
        .json({ error: "Missing required fields (customerName, startTime)." });
    }

    let tenantId = null;
    let resolvedServiceId = serviceId || null;
    let duration =
      durationMinutes && Number(durationMinutes) > 0
        ? Number(durationMinutes)
        : null;

    let serviceRow = null; // will hold requires_staff / requires_resource

    // Normalise staff/resource IDs
    const staff_id_to_use = staffId ? Number(staffId) : null;
    const resource_id_to_use = resourceId ? Number(resourceId) : null;

    // --- Preferred: tenantSlug + optional serviceId ------------------------
    if (tenantSlug) {
      const tRes = await db.query(
        "SELECT id FROM tenants WHERE slug = $1",
        [tenantSlug]
      );

      if (tRes.rows.length === 0) {
        return res.status(400).json({ error: "Unknown tenant." });
      }

      tenantId = tRes.rows[0].id;

      if (resolvedServiceId) {
        const sRes = await db.query(
          `
          SELECT id, tenant_id, duration_minutes, requires_staff, requires_resource
          FROM services
          WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE;
          `,
          [resolvedServiceId, tenantId]
        );

        if (sRes.rows.length === 0) {
          return res.status(400).json({
            error: "Unknown service for this tenant.",
          });
        }

        serviceRow = sRes.rows[0];

        if (!duration) {
          duration = serviceRow.duration_minutes;
        }
      }
    }
    // --- Fallback: only serviceId (legacy) ---------------------------------
    else if (resolvedServiceId) {
      const sRes = await db.query(
        `
        SELECT id, tenant_id, duration_minutes, requires_staff, requires_resource
        FROM services
        WHERE id = $1 AND is_active = TRUE;
        `,
        [resolvedServiceId]
      );

      if (sRes.rows.length === 0) {
        return res.status(400).json({ error: "Service not found." });
      }

      serviceRow = sRes.rows[0];
      tenantId = serviceRow.tenant_id;

      if (!duration) {
        duration = serviceRow.duration_minutes;
      }
    } else {
      return res.status(400).json({
        error: "You must provide either tenantSlug or serviceId.",
      });
    }

    // Final safety for duration
    if (!duration || duration <= 0) {
      // very last fallback – 60 minutes default if something is off
      duration = 60;
    }

    // ---- Enforce service requirements for staff/resource ------------------
    if (serviceRow) {
      if (serviceRow.requires_staff && !staff_id_to_use) {
        return res.status(400).json({
          error: "This service requires a staff member (stylist/coach).",
        });
      }
      if (serviceRow.requires_resource && !resource_id_to_use) {
        return res.status(400).json({
          error: "This service requires a resource (e.g. simulator, room).",
        });
      }
    }

    // ---- Conflict / double-booking checks ---------------------------------
    //
    // Overlap rule:
    //   existing.start < newEnd AND existingEnd > newStart
    //
    // Priority:
    // 1) If resource_id specified -> block overlapping bookings for that resource
    // 2) If staff_id specified   -> block overlapping bookings for that staff
    // 3) Else if service has no staff/resource and we have serviceId ->
    //    block overlapping bookings for same tenant+service
    //

    // 1) Resource conflict
    if (resource_id_to_use) {
      const resourceConflict = await db.query(
        `
        SELECT id
        FROM bookings
        WHERE resource_id = $1
          AND status <> 'cancelled'
          AND start_time < ($2::timestamptz + make_interval(mins => $3::int))
          AND (start_time + make_interval(mins => duration_minutes)) > $2::timestamptz
        LIMIT 1;
        `,
        [resource_id_to_use, startTime, duration]
      );

      if (resourceConflict.rows.length > 0) {
        return res.status(409).json({
          error: "Time slot already booked for this resource.",
        });
      }
    }

    // 2) Staff conflict
    if (staff_id_to_use) {
      const staffConflict = await db.query(
        `
        SELECT id
        FROM bookings
        WHERE staff_id = $1
          AND status <> 'cancelled'
          AND start_time < ($2::timestamptz + make_interval(mins => $3::int))
          AND (start_time + make_interval(mins => duration_minutes)) > $2::timestamptz
        LIMIT 1;
        `,
        [staff_id_to_use, startTime, duration]
      );

      if (staffConflict.rows.length > 0) {
        return res.status(409).json({
          error: "Time slot already booked for this staff member.",
        });
      }
    }

    // 3) Fallback: single-capacity service conflict (no staff/resource)
    if (
      tenantId &&
      resolvedServiceId &&
      serviceRow &&
      !serviceRow.requires_staff &&
      !serviceRow.requires_resource &&
      !resource_id_to_use &&
      !staff_id_to_use
    ) {
      const conflictResult = await db.query(
        `
        SELECT id
        FROM bookings
        WHERE tenant_id = $1
          AND service_id = $2
          AND status <> 'cancelled'
          AND start_time < ($3::timestamptz + make_interval(mins => $4::int))
          AND (start_time + make_interval(mins => duration_minutes)) > $3::timestamptz
        LIMIT 1;
        `,
        [tenantId, resolvedServiceId, startTime, duration]
      );

      if (conflictResult.rows.length > 0) {
        return res.status(409).json({
          error: "Time slot already booked for this service.",
        });
      }
    }

    // Insert booking with default status 'pending'
    const insertResult = await db.query(
      `
      INSERT INTO bookings (
        tenant_id,
        service_id,
        staff_id,
        resource_id,
        start_time,
        duration_minutes,
        customer_name,
        customer_phone,
        customer_email,
        status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
      RETURNING id;
      `,
      [
        tenantId,
        resolvedServiceId,
        staff_id_to_use,
        resource_id_to_use,
        startTime,
        duration,
        customerName,
        customerPhone || null,
        customerEmail || null,
      ]
    );

    const newId = insertResult.rows[0].id;

    // Return a joined row so the frontend can show it immediately
    const fullResult = await db.query(
      `
      SELECT
        b.id,
        b.service_id,
        b.staff_id,
        b.resource_id,
        b.start_time,
        b.duration_minutes,
        b.customer_name,
        b.customer_phone,
        b.customer_email,
        b.status,
        t.name  AS tenant,
        t.slug  AS tenant_slug,
        s.name  AS service_name,
        st.name AS staff_name,
        r.name  AS resource_name
      FROM bookings b
      JOIN tenants t       ON b.tenant_id = t.id
      LEFT JOIN services  s ON b.service_id  = s.id
      LEFT JOIN staff     st ON b.staff_id   = st.id
      LEFT JOIN resources r  ON b.resource_id = r.id
      WHERE b.id = $1;
      `,
      [newId]
    );

    res.status(201).json({ booking: fullResult.rows[0] });
  } catch (err) {
    console.error("Error creating booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

/**
 * Update booking status
 * POST /api/bookings/:id/status
 * Body JSON: { "status": "confirmed" | "cancelled" | "pending" }
 */
app.post("/api/bookings/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ["pending", "confirmed", "cancelled"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    // Update the booking status
    const updated = await db.query(
      `
      UPDATE bookings
      SET status = $1
      WHERE id = $2
      RETURNING id;
      `,
      [status, id]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Return the joined row so the frontend can update its table
    const joined = await db.query(
      `
      SELECT
        b.id,
        b.service_id,
        b.staff_id,
        b.resource_id,
        b.start_time,
        b.duration_minutes,
        b.customer_name,
        b.customer_phone,
        b.customer_email,
        b.status,
        t.name  AS tenant,
        t.slug  AS tenant_slug,
        s.name  AS service_name,
        st.name AS staff_name,
        r.name  AS resource_name
      FROM bookings b
      JOIN tenants t       ON b.tenant_id = t.id
      LEFT JOIN services  s ON b.service_id  = s.id
      LEFT JOIN staff     st ON b.staff_id   = st.id
      LEFT JOIN resources r  ON b.resource_id = r.id
      WHERE b.id = $1;
      `,
      [id]
    );

    res.json({ booking: joined.rows[0] });
  } catch (err) {
    console.error("Error updating booking status:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

/**
 * List bookings
 * GET /api/bookings?tenantId=1
 * GET /api/bookings?tenantSlug=salon-bella
 */
app.get("/api/bookings", async (req, res) => {
  try {
    const { tenantId, tenantSlug } = req.query;

    const params = [];
    let where = "";

    if (tenantId) {
      params.push(tenantId);
      where = "WHERE b.tenant_id = $1";
    } else if (tenantSlug) {
      params.push(tenantSlug);
      where = "WHERE t.slug = $1";
    }

    const result = await db.query(
      `
      SELECT
        b.id,
        b.service_id,
        b.staff_id,
        b.resource_id,
        b.start_time,
        b.duration_minutes,
        b.customer_name,
        b.customer_phone,
        b.customer_email,
        b.status,
        t.name  AS tenant,
        t.slug  AS tenant_slug,
        s.name  AS service_name,
        st.name AS staff_name,
        r.name  AS resource_name
      FROM bookings b
      JOIN tenants t       ON b.tenant_id = t.id
      LEFT JOIN services  s ON b.service_id  = s.id
      LEFT JOIN staff     st ON b.staff_id   = st.id
      LEFT JOIN resources r  ON b.resource_id = r.id
      ${where}
      ORDER BY b.start_time DESC;
      `,
      params
    );

    res.json({ bookings: result.rows });
  } catch (err) {
    console.error("Error loading bookings:", err);
    res.status(500).json({ error: "Failed to load bookings" });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
