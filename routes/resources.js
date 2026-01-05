// routes/resources.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, safeName } = require("../utils/r2");

// ---------------------------------------------------------------------------
// GET /api/resources?tenantSlug=&tenantId=&includeInactive=
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive } = req.query;

    const params = [];
    let where = "";

    if (tenantId) {
      params.push(Number(tenantId));
      where += ` WHERE r.tenant_id = $${params.length}`;
    } else if (tenantSlug) {
      params.push(String(tenantSlug));
      where += ` WHERE t.slug = $${params.length}`;
    }

    if (!includeInactive || includeInactive === "false") {
      where += where ? " AND r.is_active = true" : " WHERE r.is_active = true";
    }

    const q = `
      SELECT
        r.*,
        t.slug AS tenant_slug
      FROM resources r
      JOIN tenants t ON t.id = r.tenant_id
      ${where}
      ORDER BY r.created_at DESC
    `;

    const result = await db.query(q, params);
    res.json({ resources: result.rows });
  } catch (err) {
    console.error("GET /api/resources error:", err);
    res.status(500).json({ error: "Failed to fetch resources" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/resources (admin-only create)
// ---------------------------------------------------------------------------
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tenant_id, name, type, is_active } = req.body;

    const result = await db.query(
      `
      INSERT INTO resources (tenant_id, name, type, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [tenant_id, name, type || "", is_active ?? true]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/resources error:", err);
    res.status(500).json({ error: "Failed to create resource" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/resources/:id (admin-only delete)
// ---------------------------------------------------------------------------
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    await db.query(`DELETE FROM resources WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/resources/:id error:", err);
    res.status(500).json({ error: "Failed to delete resource" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/resources/:id/image (Admin only + upload)
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
        return res.status(400).json({ error: "Invalid resource id" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const cur = await db.query(
        `SELECT tenant_id, image_key FROM resources WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (!cur.rows.length) return res.status(404).json({ error: "Resource not found" });

      const tenantId = cur.rows[0].tenant_id;
      const oldKey = cur.rows[0].image_key || null;

      const key = `tenants/${tenantId}/resources/${id}/image/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath: req.file.path,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        "UPDATE resources SET image_url=$1, image_key=$2 WHERE id=$3 RETURNING *",
        [url, key, id]
      );

      if (oldKey && oldKey !== key) {
        const { deleteFromR2 } = require("../utils/r2");
        await deleteFromR2(oldKey).catch(() => {});
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Resource image upload error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);


module.exports = router;
