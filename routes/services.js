// routes/services.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, safeName } = require("../utils/r2");

// ---------------------------------------------------------------------------
// GET /api/services?tenantSlug=&tenantId=&includeInactive=
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

    if (!includeInactive || includeInactive === "false") {
      where += where ? " AND s.is_active = true" : " WHERE s.is_active = true";
    }

    const q = `
      SELECT
        s.*,
        t.slug AS tenant_slug
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
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        tenant_id,
        name,
        duration_minutes ?? 60,
        price ?? 0,
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
// POST /api/services/:id/image (Admin only + upload)
// field name must be: "file"
// ---------------------------------------------------------------------------
router.post(
  "/:id/image",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid service id" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const cur = await db.query(
        `SELECT tenant_id, image_key FROM services WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (!cur.rows.length) return res.status(404).json({ error: "Service not found" });

      const tenantId = cur.rows[0].tenant_id;
      const oldKey = cur.rows[0].image_key || null;

      const key = `tenants/${tenantId}/services/${id}/image/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath: req.file.path,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        "UPDATE services SET image_url=$1, image_key=$2 WHERE id=$3 RETURNING *",
        [url, key, id]
      );

      if (oldKey && oldKey !== key) {
        const { deleteFromR2 } = require("../utils/r2");
        await deleteFromR2(oldKey).catch(() => {});
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Service image upload error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

module.exports = router;
