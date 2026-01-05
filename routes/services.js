// routes/services.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
// Note: service data is public to support booking UI. Admin-only for mutations + uploads.
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, safeName } = require("../utils/r2");

const fsp = require("fs/promises");

// ---------------------------------------------------------------------------
// GET /api/services?tenantSlug=&tenantId=&includeInactive=
// Public (used by booking + owner UIs)
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive } = req.query;

    const params = [];
    let where = "";

    if (tenantId) {
      params.push(Number(tenantId));
      where += ` WHERE s.tenant_id = $${params.length}`;
    } else if (tenantSlug) {
      params.push(String(tenantSlug));
      where += ` WHERE t.slug = $${params.length}`;
    }

    const include = includeInactive === "true" || includeInactive === true;
    if (!include) {
      where += where ? " AND s.is_active = true" : " WHERE s.is_active = true";
    }

    const q = `
      SELECT
        s.id,
        s.tenant_id,
        s.name,
        s.duration_minutes,
        s.price,
        s.requires_staff,
        s.requires_resource,
        s.is_active,
        s.image_url,
        s.created_at
      FROM services s
      JOIN tenants t ON t.id = s.tenant_id
      ${where}
      ORDER BY s.id DESC
    `;

    const result = await db.query(q, params);
    res.json({ services: result.rows });
  } catch (err) {
    console.error("GET /api/services error:", err);
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/services (admin-only create)
// ---------------------------------------------------------------------------
router.post("/", requireAdmin, async (req, res) => {
  try {
    const {
      tenant_id,
      name,
      duration_minutes,
      price,
      requires_staff,
      requires_resource,
      is_active,
    } = req.body;

    const result = await db.query(
      `
      INSERT INTO services
        (tenant_id, name, duration_minutes, price, requires_staff, requires_resource, is_active)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [
        Number(tenant_id),
        String(name || "").trim(),
        Number(duration_minutes || 0),
        price === null || price === undefined ? null : Number(price),
        !!requires_staff,
        !!requires_resource,
        is_active ?? true,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/services error:", err);
    res.status(500).json({ error: "Failed to create service" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/services/:id (admin-only delete)
// ---------------------------------------------------------------------------
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.query(`DELETE FROM services WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/services/:id error:", err);
    res.status(500).json({ error: "Failed to delete service" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/services/:id/image (admin-only upload)
// field name must be: "file"
// ---------------------------------------------------------------------------
router.post(
  "/:id/image",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field name: file)" });
    }

    let filePath = null;

    try {
      filePath = req.file.path;

      const key = `services/${id}/image/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        "UPDATE services SET image_url=$1 WHERE id=$2 RETURNING *",
        [url, id]
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Service image upload error:", err);
      res.status(500).json({ error: "Upload failed" });
    } finally {
      if (filePath) {
        try {
          await fsp.unlink(filePath);
        } catch (_) {}
      }
    }
  }
);

module.exports = router;
