const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json()); // allow JSON bodies

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Booking backend API is running" });
});

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

// Services from Postgres
app.get("/api/services", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        s.id,
        t.id    AS tenant_id,
        t.name  AS tenant,
        s.name  AS name,
        s.duration_minutes,
        s.price_jd
      FROM services s
      JOIN tenants t ON s.tenant_id = t.id
      WHERE s.is_active = TRUE
      ORDER BY t.name, s.name;
      `
    );

    res.json({ services: result.rows });
  } catch (err) {
    console.error("Error querying services:", err);
    res.status(500).json({ error: "Failed to load services" });
  }
});

/**
 * Create a booking
 * POST /api/bookings
 * Body JSON:
 * {
 *   "serviceId": 1,
 *   "startTime": "2025-12-05T18:00:00Z",
 *   "durationMinutes": 60,   // optional, defaults to service duration
 *   "customerName": "Akef",
 *   "customerPhone": "+962...",
 *   "customerEmail": "you@example.com"
 * }
 */
app.post("/api/bookings", async (req, res) => {
  try {
    const {
      serviceId,
      startTime,
      durationMinutes,
      customerName,
      customerPhone,
      customerEmail,
    } = req.body;

    if (!serviceId || !startTime || !customerName) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Look up the service to get tenant_id and default duration
    const serviceResult = await db.query(
      "SELECT tenant_id, duration_minutes FROM services WHERE id = $1",
      [serviceId]
    );

    if (serviceResult.rows.length === 0) {
      return res.status(400).json({ error: "Service not found" });
    }

    const serviceRow = serviceResult.rows[0];
    const duration =
      durationMinutes && Number(durationMinutes) > 0
        ? durationMinutes
        : serviceRow.duration_minutes;

    const insertResult = await db.query(
      `
      INSERT INTO bookings (
        tenant_id,
        service_id,
        start_time,
        duration_minutes,
        customer_name,
        customer_phone,
        customer_email
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
      `,
      [
        serviceRow.tenant_id,
        serviceId,
        startTime,
        duration,
        customerName,
        customerPhone || null,
        customerEmail || null,
      ]
    );

    res.status(201).json({ booking: insertResult.rows[0] });
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
        b.start_time,
        b.duration_minutes,
        b.customer_name,
        b.customer_phone,
        b.customer_email,
        b.status,
        t.name  AS tenant,
        t.slug  AS tenant_slug,
        s.name  AS service_name
      FROM bookings b
      JOIN tenants t ON b.tenant_id = t.id
      JOIN services s ON b.service_id = s.id
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
        b.start_time,
        b.duration_minutes,
        b.customer_name,
        b.customer_phone,
        b.customer_email,
        b.status,
        t.name  AS tenant,
        t.slug  AS tenant_slug,
        s.name  AS service_name
      FROM bookings b
      JOIN tenants t ON b.tenant_id = t.id
      JOIN services s ON b.service_id = s.id
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

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
