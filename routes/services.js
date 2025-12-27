// routes/services.js
const express = require("express");
const router = express.Router();
const db = require("../db");

const requireAdmin = require("../middleware/requireAdmin");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { upload, uploadErrorHandler } = require("../middleware/upload");

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

// GET /api/services?tenantSlug=&tenantId=&includeInactive=
// Returns services with tenant name/slug and basic fields
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive } = req.query;

    let where = "";
    const params = [];
    let idx = 1;

    if (tenantId) {
      params.push(Number(tenantId));
      where = `WHERE s.tenant_id = $${idx}`;
      idx++;
    } else if (tenantSlug) {
      params.push(tenantSlug);
      where = `WHERE t.slug = $${idx}`;
      idx++;
    }

    // default: only active unless includeInactive=1/true
    const inc =
      String(includeInactive || "")
        .toLowerCase()
        .trim() === "true" || String(includeInactive || "").trim() === "1";

    if (!inc) {
      where += where ? " AND s.is_active = TRUE" : "WHERE s.is_active = TRUE";
    }

    const q = `
      SELECT
        s.id,
        s.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant_name,
        s.name,
        s.duration_minutes,
        s.price_jd,
        s.requires_staff,
        s.requires_resource,
        s.image_url,
        s.is_active,
        s.created_at
      FROM services s
      JOIN tenants t ON s.tenant_id = t.id
      ${where}
      ORDER BY t.name ASC, s.name ASC
    `;

    const result = await db.query(q, params);
    res.json({ services: result.rows });
  } catch (err) {
    console.error("Error loading services:", err);
    res.status(500).json({ error: "Failed to load services" });
  }
});

// POST /api/services
// Body: { tenantSlug?, tenantId?, name, durationMinutes?, priceJd?, requiresStaff?, requiresResource? }
router.post("/", requireAdmin, async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId,
      name,
      durationMinutes,
      priceJd,
      requiresStaff,
      requiresResource,
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Service name is required." });
    }

    // Resolve tenant_id
    let resolvedTenantId = tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      const tRes = await db.query(
        `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
        [String(tenantSlug)]
      );
      resolvedTenantId = tRes.rows[0]?.id || null;
    }

    if (!resolvedTenantId) {
      return res.status(400).json({
        error: "Missing tenantId or tenantSlug to create a service.",
      });
    }

    const insert = await db.query(
      `
      INSERT INTO services
        (tenant_id, name, duration_minutes, price_jd, requires_staff, requires_resource)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      RETURNING
        id, tenant_id, name, duration_minutes, price_jd, requires_staff, requires_resource, image_url, is_active, created_at
      `,
      [
        resolvedTenantId,
        String(name).trim(),
        Number(durationMinutes || 60),
        priceJd == null ? null : Number(priceJd),
        Boolean(requiresStaff),
        Boolean(requiresResource),
      ]
    );

    res.json({ service: insert.rows[0] });
  } catch (err) {
    console.error("Error creating service:", err);
    res.status(500).json({ error: "Failed to create service" });
  }
});

// DELETE /api/services/:id
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid service id." });

    // soft-delete style (set inactive) if your schema uses is_active
    // If your index.js was doing hard-delete, swap to DELETE FROM.
    const result = await db.query(
      `
      UPDATE services
      SET is_active = FALSE
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Service not found." });
    }

    res.json({ ok: true, id });
  } catch (err) {
    console.error("Error deleting service:", err);
    res.status(500).json({ error: "Failed to delete service" });
  }
});

// POST /api/services/:id/image
router.post(
  "/:id/image",
  requireGoogleAuth,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) {
        return res.status(400).json({ error: "Invalid service id." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      // The file is stored by multer diskStorage. Build a public URL path.
      // Your app.js serves /uploads as static.
      const imageUrl = `/uploads/${req.file.filename}`;

      // Update service image
      const sRes = await db.query(
        `
        UPDATE services
        SET image_url = $1
        WHERE id = $2
        RETURNING id, tenant_id, name, duration_minutes, price_jd, requires_staff, requires_resource, image_url, is_active
        `,
        [imageUrl, id]
      );

      if (!sRes.rows.length) {
        return res.status(404).json({ error: "Service not found." });
      }

      return res.json({ ok: true, imageUrl, service: sRes.rows[0] });
    } catch (err) {
      console.error("Service image upload error:", err);
      return res.status(500).json({ error: "Failed to upload image." });
    }
  }
);

module.exports = router;
