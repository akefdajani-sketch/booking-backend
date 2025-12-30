// routes/tenants.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");

// ✅ IMPORTANT: destructure these (do NOT do: const upload = require(...))
const { upload, uploadErrorHandler } = require("../middleware/upload");

const { uploadFileToR2, safeName } = require("../utils/r2");

const fs = require("fs/promises");

// -----------------------------------------------------------------------------
// GET /api/tenants
// Public: returns list of tenants (safe fields only)
// -----------------------------------------------------------------------------
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

    return res.json({ tenants: result.rows });
  } catch (err) {
    console.error("Error loading tenants:", err);
    return res.status(500).json({ error: "Failed to load tenants" });
  }
});

// -----------------------------------------------------------------------------
// GET /api/tenants/by-slug/:slug
// Public: returns one tenant by slug (scale-friendly for owner/[slug])
// -----------------------------------------------------------------------------
router.get("/by-slug/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing slug" });

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
      WHERE slug = $1
      LIMIT 1
      `,
      [slug]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    return res.json({ tenant: result.rows[0] });
  } catch (err) {
    console.error("Error loading tenant by slug:", err);
    return res.status(500).json({ error: "Failed to load tenant" });
  }
});

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/logo
// Admin: upload tenant logo to R2 and update tenants.logo_url
// field name must be: "file"
// -----------------------------------------------------------------------------
router.post(
  "/:id/logo",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    let filePath = null;

    try {
      const id = Number(req.params.id);

      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid tenant id" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;

      const key = `tenants/${id}/logo/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        "UPDATE tenants SET logo_url=$1 WHERE id=$2 RETURNING *",
        [url, id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      console.error("Tenant logo upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      // ✅ P0: prevent disk growth from temp upload files
      if (filePath) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }
);

module.exports = router;
