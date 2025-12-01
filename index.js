const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json()); // <-- allow JSON bodies

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Booking backend API is running" });
});

// Services from Postgres
app.get("/api/services", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        s.id,
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
 *   "tenantId": 1,
 *   "serviceId": 1,
 *   "startTime": "2025-12-05T18:00:00Z",
 *   "durationMinutes": 60,
 *   "customerName": "Akef",
 *   "customerPhone": "+962...",
 *   "customerEmail": "you@example.com"
 * }
 */
app.post("/api/bookings", async (req, res) => {
  try {
    const {
      tenantId,
      serviceId,
      startTime,
      durationMinutes,
      customerName,
      customerPhone,
      customerEmail,
    } = req.body;

    if (
      !tenantId ||
      !serviceId ||
      !startTime ||
      !durationMinutes ||
      !customerName
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

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
        tenantId,
        serviceId,
        startTime,
        durationMinutes,
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
 * List bookings (basic, for now)
 * GET /api/bookings?tenantId=1
 */
app.get("/api/bookings", async (req, res) => {
  try {
    const { tenantId } = req.query;

    const params = [];
    let where = "";

    if (tenantId) {
      params.push(tenantId);
      where = "WHERE b.tenant_id = $1";
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
