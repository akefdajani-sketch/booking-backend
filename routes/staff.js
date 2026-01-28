// routes/staff.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const { assertWithinPlanLimit } = require("../utils/planEnforcement");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, safeName } = require("../utils/r2");

const fs = require("fs/promises");

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
    // Frontend uses: { tenant_id, name, role, is_active }
    // Legacy support: some older clients used `title` instead of `role`.
    const { tenant_id, name, role, title, is_active } = req.body;

    if (!tenant_id || !name) {
      return res.status(400).json({ error: "tenant_id and name are required" });
    }

    // Phase D1: enforce plan limits (creation guard)
    try {
      await assertWithinPlanLimit(Number(tenant_id), "staff");
    } catch (e) {
      return res.status(e.status || 403).json({
        error: e.message || "Plan limit reached",
        code: e.code || "PLAN_LIMIT_REACHED",
        kind: e.kind || "staff",
        limit: e.limit,
        current: e.current,
        plan_code: e.plan_code,
      });
    }

    const roleValue = (role ?? title ?? "").toString();

    const result = await db.query(
      `
      INSERT INTO staff (tenant_id, name, role, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [tenant_id, name, roleValue, is_active ?? true]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/staff error:", err);
    res.status(500).json({ error: "Failed to create staff" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/staff/:id (admin-only delete)
// If blocked by FK (e.g. existing bookings), we soft-disable instead of hard delete.
// ---------------------------------------------------------------------------
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    try {
      await db.query(`DELETE FROM staff WHERE id=$1`, [id]);
      return res.json({ ok: true, deleted: true });
    } catch (err) {
      // 23503 = foreign_key_violation
      if (err && err.code === "23503") {
        const result = await db.query(
          `UPDATE staff SET is_active=false WHERE id=$1 RETURNING id, is_active`,
          [id]
        );
        if (!result.rows.length) {
          return res.status(404).json({ error: "Staff not found" });
        }
        return res.json({ ok: true, deleted: false, deactivated: true });
      }
      throw err;
    }
  } catch (err) {
    console.error("DELETE /api/staff/:id error:", err);
    return res.status(500).json({ error: "Failed to delete staff" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/staff/:id/image (admin-only upload)
// field name must be: "file"
// NOTE: Frontend uses Next.js proxy that adds x-api-key, so this must be requireAdmin.
// ---------------------------------------------------------------------------
router.post(
  "/:id/image",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    let filePath = null;

    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid staff id" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      filePath = req.file.path;

      // Resolve tenant_id for clean multi-tenant key structure
      const staffRow = await db.query("SELECT tenant_id FROM staff WHERE id=$1", [id]);
      const tenantId = staffRow.rows?.[0]?.tenant_id;
      if (!tenantId) return res.status(404).json({ error: "Staff not found" });

      // Treat this as the staff avatar upload: update BOTH avatar_url + image_url
      const key = `tenants/${tenantId}/staff/${id}/avatar/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        "UPDATE staff SET avatar_url=$1, image_url=$1 WHERE id=$2 RETURNING *",
        [url, id]
      );

      if (!result.rows.length) return res.status(404).json({ error: "Staff not found" });

      return res.json(result.rows[0]);
    } catch (err) {
      console.error("Staff image upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      // prevent disk growth from temp upload files
      if (filePath) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }
);


// ---------------------------------------------------------------------------
// DELETE /api/staff/:id/image (admin-only)
// Clears avatar_url + image_url. (R2 deletion is best-effort and depends on stored keys.)
// ---------------------------------------------------------------------------
router.delete("/:id/image", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid staff id" });
    }

    const result = await db.query(
      "UPDATE staff SET avatar_url=NULL, image_url=NULL WHERE id=$1 RETURNING *",
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Staff not found" });
    }

    return res.json({ ok: true, staff: result.rows[0] });
  } catch (err) {
    console.error("DELETE /api/staff/:id/image error:", err);
    return res.status(500).json({ error: "Failed to delete staff image" });
  }
});

module.exports = router;
