// routes/resources.js
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

    if (!tenant_id || !name) {
      return res.status(400).json({ error: "tenant_id and name are required" });
    }

    // Phase D1: enforce plan limits (creation guard)
    try {
      await assertWithinPlanLimit(Number(tenant_id), "resources");
    } catch (e) {
      return res.status(e.status || 403).json({
        error: e.message || "Plan limit reached",
        code: e.code || "PLAN_LIMIT_REACHED",
        kind: e.kind || "resources",
        limit: e.limit,
        current: e.current,
        plan_code: e.plan_code,
      });
    }

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
// POST /api/resources/:id/image (admin-only upload)
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
        return res.status(400).json({ error: "Invalid resource id" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      filePath = req.file.path;

      const key = `resources/${id}/image/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        "UPDATE resources SET image_url=$1 WHERE id=$2 RETURNING *",
        [url, id]
      );

      if (!result.rows.length)
        return res.status(404).json({ error: "Resource not found" });

      return res.json(result.rows[0]);
    } catch (err) {
      console.error("Resource image upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      // prevent disk growth from temp upload files
      if (filePath) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }
);

module.exports = router;
