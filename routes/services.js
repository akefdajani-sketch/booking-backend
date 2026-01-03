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
        s.id,
        s.tenant_id,
        s.name,
        s.duration_minutes,
        s.price,
        s.requires_staff,
        s.requires_resource,
        s.is_active,
        s.image_url,

        -- New service-level time controls
        COALESCE(s.slot_interval_minutes, 60)     AS slot_interval_minutes,
        COALESCE(s.max_consecutive_slots, 4)      AS max_consecutive_slots,
        COALESCE(s.max_parallel_bookings, 1)      AS max_parallel_bookings,

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

      // New fields
      slot_interval_minutes,
      max_consecutive_slots,
      max_parallel_bookings,
    } = req.body;

    const dur = Number(duration_minutes ?? 60) || 60;
    const interval = Number(slot_interval_minutes ?? 60) || 60;

    // default max slots: at least enough to cover min duration, but allow more if provided
    const minSlots = Math.max(1, Math.ceil(dur / interval));
    const maxSlots = Number(max_consecutive_slots ?? Math.max(4, minSlots)) || Math.max(4, minSlots);

    const parallel = Number(max_parallel_bookings ?? 1) || 1;

    const result = await db.query(
      `
      INSERT INTO services
        (
          tenant_id, name, duration_minutes, price,
          requires_staff, requires_resource, is_active,
          slot_interval_minutes, max_consecutive_slots, max_parallel_bookings
        )
      VALUES
        ($1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, $10)
      RETURNING *
      `,
      [
        tenant_id,
        name,
        dur,
        price ?? 0,
        !!requires_staff,
        !!requires_resource,
        is_active ?? true,
        interval,
        maxSlots,
        parallel,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/services error:", err);
    res.status(500).json({ error: "Failed to create service" });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/services/:id (admin-only update)
// Used by Setup editing (B).
// ---------------------------------------------------------------------------
router.put("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid service id." });
    }

    const {
      name,
      duration_minutes,
      price,
      requires_staff,
      requires_resource,
      is_active,
      slot_interval_minutes,
      max_consecutive_slots,
      max_parallel_bookings,
    } = req.body || {};

    // Load current (for safe fallbacks)
    const cur = await db.query(`SELECT * FROM services WHERE id=$1 LIMIT 1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ error: "Service not found." });

    const prev = cur.rows[0];

    const dur = Number(duration_minutes ?? prev.duration_minutes ?? 60) || 60;
    const interval = Number(slot_interval_minutes ?? prev.slot_interval_minutes ?? 60) || 60;

    const minSlots = Math.max(1, Math.ceil(dur / interval));
    const maxSlotsRaw = Number(max_consecutive_slots ?? prev.max_consecutive_slots ?? Math.max(4, minSlots));
    const maxSlots = Math.max(minSlots, maxSlotsRaw || Math.max(4, minSlots));

    const parallelRaw = Number(max_parallel_bookings ?? prev.max_parallel_bookings ?? 1);
    const parallel = Math.max(1, parallelRaw || 1);

    const upd = await db.query(
      `
      UPDATE services
      SET
        name = $1,
        duration_minutes = $2,
        price = $3,
        requires_staff = $4,
        requires_resource = $5,
        is_active = $6,
        slot_interval_minutes = $7,
        max_consecutive_slots = $8,
        max_parallel_bookings = $9
      WHERE id = $10
      RETURNING *
      `,
      [
        name ?? prev.name,
        dur,
        price ?? prev.price ?? 0,
        requires_staff ?? prev.requires_staff ?? false,
        requires_resource ?? prev.requires_resource ?? false,
        is_active ?? prev.is_active ?? true,
        interval,
        maxSlots,
        parallel,
        id,
      ]
    );

    return res.json(upd.rows[0]);
  } catch (err) {
    console.error("PUT /api/services/:id error:", err);
    return res.status(500).json({ error: "Failed to update service" });
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
// POST /api/services/:id/image (Google auth + upload)
// field name must be: "file"
// ---------------------------------------------------------------------------
router.post(
  "/:id/image",
  requireGoogleAuth,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const key = `services/${id}/image/${Date.now()}-${safeName(req.file.originalname)}`;

      const { url } = await uploadFileToR2({
        filePath: req.file.path,
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
    }
  }
);

module.exports = router;
