// routes/resources.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
const { requireTenant } = require("../middleware/requireTenant");
async function resolveTenantFromResourceId(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid id" });
    const { rows } = await db.query("SELECT tenant_id FROM resources WHERE id = $1", [id]);
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    req.tenantId = Number(rows[0].tenant_id);
    req.body = req.body || {};
    req.body.tenantId = req.body.tenantId || req.tenantId;
    return next();
  } catch (e) {
    console.error("resolveTenantFromResourceId error:", e);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}
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
router.post("/", requireTenant, requireAdminOrTenantRole("manager"), async (req, res) => {
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
// If blocked by FK (e.g. existing bookings), we soft-disable instead of hard delete.
// ---------------------------------------------------------------------------
router.delete("/:id", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
  try {
    const id = Number(req.params.id);

    try {
      await db.query(`DELETE FROM resources WHERE id=$1`, [id]);
      return res.json({ ok: true, deleted: true });
    } catch (err) {
      // 23503 = foreign_key_violation
      if (err && err.code === "23503") {
        const result = await db.query(
          `UPDATE resources SET is_active=false WHERE id=$1 RETURNING id, is_active`,
          [id]
        );
        if (!result.rows.length) {
          return res.status(404).json({ error: "Resource not found" });
        }
        return res.json({ ok: true, deleted: false, deactivated: true });
      }
      throw err;
    }
  } catch (err) {
    console.error("DELETE /api/resources/:id error:", err);
    return res.status(500).json({ error: "Failed to delete resource" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/resources/:id/image (admin-only upload)
// field name must be: "file"
// NOTE: Frontend uses Next.js proxy that adds x-api-key, so this must be requireAdmin.
// ---------------------------------------------------------------------------
router.post(
  "/:id/image",
  resolveTenantFromResourceId,
  requireAdminOrTenantRole("manager"),
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



// ---------------------------------------------------------------------------
// DELETE /api/resources/:id/image (admin-only)
// Clears image_url. (R2 deletion is best-effort and depends on stored keys.)
// ---------------------------------------------------------------------------
router.delete("/:id/image", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid resource id" });
    }

    const result = await db.query(
      "UPDATE resources SET image_url=NULL WHERE id=$1 RETURNING *",
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Resource not found" });
    }

    return res.json({ ok: true, resource: result.rows[0] });
  } catch (err) {
    console.error("DELETE /api/resources/:id/image error:", err);
    return res.status(500).json({ error: "Failed to delete resource image" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/resources/:id (admin/manager)
// Allows updating resource fields (name/type/is_active).
// `type` is stored as free text (so "Other" can be a custom value).
// ---------------------------------------------------------------------------
router.patch("/:id", resolveTenantFromResourceId, requireAdminOrTenantRole("manager"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "invalid id" });

    const { name, type, is_active } = req.body || {};

    const sets = [];
    const params = [];
    const add = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (name !== undefined) add("name", name == null ? null : String(name).trim());
    if (type !== undefined) add("type", type == null ? null : String(type).trim());
    if (is_active !== undefined) add("is_active", !!is_active);

    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    params.push(id);
    const q = `UPDATE resources SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`;
    const result = await db.query(q, params);
    if (!result.rows.length) return res.status(404).json({ error: "Resource not found" });
    return res.json({ ok: true, resource: result.rows[0] });
  } catch (err) {
    console.error("PATCH /api/resources/:id error:", err);
    return res.status(500).json({ error: "Failed to update resource" });
  }
});

module.exports = router;
