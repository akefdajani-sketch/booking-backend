const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

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

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
