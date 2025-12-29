// routes/staff.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, safeName } = require("../utils/r2");

// GET /api/staff?tenantSlug=&tenantId=&includeInactive=
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive } = req.query;

    const params = [];
    let where = "";
    let idx = 1;

    if (tenantId) {
      params.push(Number(tenantId));
      where = `WHERE st.tenant_id = $${idx}`;
      idx++;
    } else if (tenantSlug) {
      // resolve by slug
      params.push(String(tenantSlug));
      where = `WHERE t.slug = $${idx}`;
      idx++;
    }

    const inc =
      String(includeInactive || "").toLowerCase().trim() === "true" ||
      String(includeInactive || "").trim() === "1";

    if (!inc) {
      where += where ? " AND st.is_active = TRUE" : "WHERE st.is_active = TRUE";
    }

    const q = `
      SELECT
        st.id,
        st.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant_name,
        st.name,
        st.role,
        st.photo_url,
        st.avatar_url,
        st.is_active,
        st.created_at
      FROM staff st
      JOIN tenants t ON t.id = st.tenant_id
      ${where}
      ORDER BY t.name ASC, st.name ASC
    `;

    const result = await db.query(q, params);
    return res.json({ staff: result.rows });
  } catch (err) {
    console.error("Error loading staff:", err);
    return res.status(500).json({ error: "Failed to load staff" });
  }
});

// POST /api/staff  (admin)
// Body: { tenantSlug? | tenantId, name, role? }
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, role } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Staff name is required." });
    }

    let resolvedTenantId = tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      const tRes = await db.query(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [
        String(tenantSlug),
      ]);
      resolvedTenantId = tRes.rows?.[0]?.id || null;
    }

    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantId or tenantSlug." });
    }

    const insert = await db.query(
      `
      INSERT INTO staff (tenant_id, name, role, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id, tenant_id, name, role, photo_url, avatar_url, is_active, created_at
      `,
      [resolvedTenantId, String(name).trim(), role ? String(role).trim() : null]
    );

    return res.json({ staff: insert.rows[0] });
  } catch (err) {
    console.error("Error creating staff:", err);
    return res.status(500).json({ error: "Failed to create staff" });
  }
});

// DELETE /api/staff/:id (admin) - soft delete
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid staff id." });

    const result = await db.query(
      `
      UPDATE staff
      SET is_active = FALSE
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (!result.rows.length) return res.status(404).json({ error: "Staff not found." });
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("Error deleting staff:", err);
    return res.status(500).json({ error: "Failed to delete staff" });
  }
});

// POST /api/staff/:id/image  (Google auth + upload)
router.post("/:id/image", requireGoogleAuth, upload.single("file"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const key = `staff/${id}/${Date.now()}-${safeName(req.file.originalname)}`;

    const { url } = await uploadFileToR2({
      filePath: req.file.path,
      contentType: req.file.mimetype,
      key,
    });

    const result = await pool.query(
      "UPDATE staff SET image_url=$1 WHERE id=$2 RETURNING *",
      [url, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Staff image upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

module.exports = router;
