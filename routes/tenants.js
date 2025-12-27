// routes/tenants.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

// GET /api/tenants
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        id,
        slug,
        name,
        kind,
        timezone,
        logo_url,
        cover_image_url,
        created_at
      FROM tenants
      ORDER BY name ASC
      `
    );

    res.json({ tenants: result.rows });
  } catch (err) {
    console.error("Error loading tenants:", err);
    res.status(500).json({ error: "Failed to load tenants" });
  }
});

module.exports = router;
