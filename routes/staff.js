// routes/staff.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, safeName } = require("../utils/r2");

// ---------------------------------------------------------------------------
// GET /api/staff?tenantSlug=&tenantId=&includeInactive=
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive } = req.query;

    const params = [];
    let where = "";

    if (tenantId) {
      params.push(Number(tenantId));
      where += ` WHERE st.tenant_id = $${params.length}`;
    } else if (tenantSlug) {
      params.push(String(tenantSlug));
      where += ` WHERE t.slug = $${params.length}`;
    }

    if (!includeInactive || includeInactive === "false") {
      where += where ? " AND st.is_active = true" : " WHERE st.is_active = true";
    }

    const q = `
      SELECT
        st.*,
        t.slug AS tenant_slug
      FROM staff st
      JOIN tenants t ON t.id = st.tenant_id
      ${where}
      ORDER BY st.created_at DESC
    `;

    const result = await db.query(q, params);
    res.json({ staff: result.rows });
  } catch (err) {
    console.error("GET /api/staff error:", err);
    res.status(500).json({ error: "Failed to fetch staff" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/staff (admin-only create)
// ---------------------------------------------------------------------------
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tenant_id, name, title, is_active } = req.body;

    const result = await db.query(
      `
      INSERT INTO staff (tenant_id, name, title, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [tenant_id, name, title || "", is_active ?? true]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/staff error:", err);
    res.status(500).json({ error: "Failed to create staff" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/staff/:id (admin-only delete)
// ---------------------------------------------------------------------------
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.query(`DELETE FROM staff WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/staff/:id error:", err);
    res.status(500).json({ error: "Failed to delete staff" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/staff/:id/photo (admin-only upload)
// field name must be: "file"
// Stores: staff.photo_url + staff.photo_key
// ---------------------------------------------------------------------------
router.post(
  "/:id/photo",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid staff id" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      // Fetch tenant_id and old key
      const cur = await db.query(
        `SELECT tenant_id, photo_key FROM staff WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (!cur.rows.length) return res.status(404).json({ error: "Staff not found" });

      const tenantId = cur.rows[0].tenant_id;
      const oldKey = cur.rows[0].photo_key || null;

      const key = `tenants/${tenantId}/staff/${id}/photo/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath: req.file.path,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        "UPDATE staff SET photo_url=$1, photo_key=$2 WHERE id=$3 RETURNING *",
        [url, key, id]
      );

      if (oldKey && oldKey !== key) {
        const { deleteFromR2 } = require("../utils/r2");
        await deleteFromR2(oldKey).catch(() => {});
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Staff photo upload error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

module.exports = router;
