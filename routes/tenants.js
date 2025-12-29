// routes/tenants.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const upload = require("../middleware/upload");
const { uploadFileToR2, safeName } = require("../utils/r2");

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

// POST /api/services/:id/image
router.post("/:id/logo", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const key = `tenants/${id}/logo/${Date.now()}-${safeName(req.file.originalname)}`;

    const { url } = await uploadFileToR2({
      filePath: req.file.path,
      contentType: req.file.mimetype,
      key,
    });

    const result = await pool.query(
      "UPDATE tenants SET logo_url=$1 WHERE id=$2 RETURNING *",
      [url, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Tenant logo upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

module.exports = router;
