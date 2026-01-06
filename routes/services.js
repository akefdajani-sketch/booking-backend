// routes/services.js
const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");

// Upload middleware (multer) + error handler
const { upload, uploadErrorHandler } = require("../middleware/upload");

// Cloudflare R2 helper
const { uploadFileToR2, safeName } = require("../utils/r2");

const fsp = require("fs/promises");

// ---------------------------------------------------------------------------
// GET /api/services?tenantSlug=&tenantId=&includeInactive=1
// Public (used by booking UI + owner setup UI)
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive } = req.query;

    const where = [];
    const params = [];

    if (tenantId) {
      params.push(Number(tenantId));
      where.push(`s.tenant_id = $${params.length}`);
    } else if (tenantSlug) {
      params.push(String(tenantSlug));
      where.push(`t.slug = $${params.length}`);
    }

    // default: only active services unless includeInactive=1
    if (!includeInactive || String(includeInactive) !== "1") {
      where.push(`COALESCE(s.is_active, true) = true`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const q = `
      SELECT
        s.id,
        s.tenant_id,
        s.name,
        s.description,
        s.duration_minutes,
        s.price_jd,
        s.slot_interval_minutes AS slot_interval_minutes,
        s.max_consecutive_slots AS max_consecutive_slots,
        s.max_parallel_bookings AS max_parallel_bookings,
        COALESCE(s.requires_staff, false)    AS requires_staff,
        COALESCE(s.requires_resource, false) AS requires_resource,
        COALESCE(s.is_active, true)          AS is_active,
        s.image_url
      FROM services s
      JOIN tenants t ON t.id = s.tenant_id
      ${whereSql}
      ORDER BY s.id DESC
    `;

    const { rows } = await db.query(q, params);
    return res.json(rows);
  } catch (err) {
    console.error("Error loading services:", err);
    return res.status(500).json({ error: "Failed to load services" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/services
// Admin-only create
// Body: { tenantSlug | tenantId, name, duration_minutes, price_jd, requires_staff, requires_resource }
// ---------------------------------------------------------------------------
router.post("/", requireAdmin, async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId,
      name,
	      description,
      duration_minutes,
      price_jd,
	      slot_interval_minutes,
	      max_consecutive_slots,
	      max_parallel_bookings,
      requires_staff,
      requires_resource,
      is_active,
    } = req.body || {};

    if (!name || String(name).trim().length === 0) {
      return res.status(400).json({ error: "name is required" });
    }

    let tenant_id = tenantId ? Number(tenantId) : null;

    if (!tenant_id && tenantSlug) {
      const t = await db.query("SELECT id FROM tenants WHERE slug = $1", [
        String(tenantSlug),
      ]);
      tenant_id = t.rows?.[0]?.id ?? null;
    }

    if (!tenant_id) {
      return res.status(400).json({ error: "tenantId or tenantSlug is required" });
    }

    const q = `
      INSERT INTO services
        (
          tenant_id,
          name,
          description,
          duration_minutes,
          price_jd,
          slot_interval_minutes,
          max_consecutive_slots,
          max_parallel_bookings,
          requires_staff,
          requires_resource,
          is_active
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING
        id,
        tenant_id,
        name,
        description,
        duration_minutes,
        price_jd,
        slot_interval_minutes,
        max_consecutive_slots,
        max_parallel_bookings,
        COALESCE(requires_staff,false) AS requires_staff,
        COALESCE(requires_resource,false) AS requires_resource,
        COALESCE(is_active,true) AS is_active,
        image_url
    `;

    const params = [
      tenant_id,
      String(name).trim(),
      description == null ? null : String(description).trim(),
      duration_minutes == null ? null : Number(duration_minutes),
      price_jd == null ? null : Number(price_jd),
      slot_interval_minutes == null ? null : Number(slot_interval_minutes),
      max_consecutive_slots == null ? null : Number(max_consecutive_slots),
      max_parallel_bookings == null ? null : Number(max_parallel_bookings),
      !!requires_staff,
      !!requires_resource,
      is_active == null ? true : !!is_active,
    ];

    const { rows } = await db.query(q, params);
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error creating service:", err);
    return res.status(500).json({ error: "Failed to create service" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/services/:id
// Admin-only delete
// ---------------------------------------------------------------------------
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid id" });

    // Optional: if you track image_key in DB and want to delete from R2 too,
    // add it here. For now we just delete the row.
    await db.query("DELETE FROM services WHERE id = $1", [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting service:", err);
    return res.status(500).json({ error: "Failed to delete service" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/services/:id/image (admin-only upload)
// field name must be: "file"
// Saves to R2 and persists URL/key on services row.
// ---------------------------------------------------------------------------
router.post(
  "/:id/image",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    const id = Number(req.params.id);

    if (!id) return res.status(400).json({ error: "invalid id" });
    if (!req.file) return res.status(400).json({ error: "file is required" });

    const tmpPath = req.file.path;

    try {
      // Fetch tenant slug + service name (for naming)
      const meta = await db.query(
        `
        SELECT s.id, s.name AS service_name, t.slug AS tenant_slug
        FROM services s
        JOIN tenants t ON t.id = s.tenant_id
        WHERE s.id = $1
        `,
        [id]
      );

      if (!meta.rows.length) return res.status(404).json({ error: "not found" });

      const { tenant_slug, service_name } = meta.rows[0];

      const safeTenant = safeName(tenant_slug || "tenant");
      const safeService = safeName(service_name || `service-${id}`);

      // Keep a stable folder structure for multi-tenant
      const key = `tenants/${safeTenant}/services/${id}-${safeService}-${Date.now()}`;

      const { url } = await uploadFileToR2({
        filePath: tmpPath,
        contentType: req.file.mimetype,
        key,
      });

      // If you don't have image_key in DB, remove it from the query.
      const upd = await db.query(
        `
        UPDATE services
        SET image_url = $2,
            image_key = $3
        WHERE id = $1
        RETURNING id, image_url
        `,
        [id, url, key]
      );

      return res.json({
        ok: true,
        id: upd.rows?.[0]?.id ?? id,
        image_url: upd.rows?.[0]?.image_url ?? url,
        image_key: key,
      });
    } catch (err) {
      console.error("Error uploading service image:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      // Always clean up temp file
      try {
        await fsp.unlink(tmpPath);
      } catch (_) {}
    }
  }
);

module.exports = router;
