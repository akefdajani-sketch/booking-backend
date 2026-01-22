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

const ALLOWED_AVAILABILITY_BASIS = new Set(["auto", "resource", "staff", "both", "none"]);
function normalizeAvailabilityBasis(v) {
  if (v == null || v === "") return null;
  const s = String(v).toLowerCase().trim();
  if (!ALLOWED_AVAILABILITY_BASIS.has(s)) return null;
  return s;
}

async function getServicesColumns() {
  const { rows } = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services'
    `
  );
  return new Set(rows.map((r) => r.column_name));
}

async function getTenantsColumns() {
  const { rows } = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenants'
    `
  );
  return new Set(rows.map((r) => r.column_name));
}

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

    const svcCols = await getServicesColumns();
    const tenantCols = await getTenantsColumns();

    // Pricing:
    // Your current DB uses services.price_amount (numeric).
    // Keep backward compatibility with older schemas that used services.price.
    const priceExpr =
      svcCols.has("price_amount") && svcCols.has("price")
        ? "COALESCE(s.price_amount, s.price) AS price_amount"
        : svcCols.has("price_amount")
        ? "s.price_amount AS price_amount"
        : svcCols.has("price")
        ? "s.price AS price_amount"
        : "NULL::numeric AS price_amount";

    const maxParallelExpr =
      svcCols.has("max_parallel_bookings") && svcCols.has("max_parallel")
        ? "COALESCE(s.max_parallel_bookings, s.max_parallel) AS max_parallel_bookings"
        : svcCols.has("max_parallel_bookings")
        ? "s.max_parallel_bookings AS max_parallel_bookings"
        : svcCols.has("max_parallel")
        ? "s.max_parallel AS max_parallel_bookings"
        : "NULL::int AS max_parallel_bookings";

    const slotIntervalExpr = svcCols.has("slot_interval_minutes")
      ? "s.slot_interval_minutes AS slot_interval_minutes"
      : "NULL::int AS slot_interval_minutes";

    const maxConsecutiveExpr = svcCols.has("max_consecutive_slots")
      ? "s.max_consecutive_slots AS max_consecutive_slots"
      : svcCols.has("max_consecutive_slots")
      ? "s.max_consecutive_slots AS max_consecutive_slots"
      : "NULL::int AS max_consecutive_slots";

    const imageExpr =
      svcCols.has("image_url") && svcCols.has("photo_url")
        ? "COALESCE(s.image_url, s.photo_url) AS image_url"
        : svcCols.has("image_url")
        ? "s.image_url AS image_url"
        : svcCols.has("photo_url")
        ? "s.photo_url AS image_url"
        : "NULL::text AS image_url";

    const currencyExpr = tenantCols.has("currency_code")
      ? "t.currency_code AS currency_code"
      : "NULL::text AS currency_code";

    const requiresConfirmationExpr = svcCols.has("requires_confirmation")
      ? "COALESCE(s.requires_confirmation, false) AS requires_confirmation"
      : "false::boolean AS requires_confirmation";

    const q = `
      SELECT
        s.id,
        s.tenant_id,
        s.name,
        s.description,
        s.duration_minutes,
        ${priceExpr},
        ${slotIntervalExpr},
        ${maxConsecutiveExpr},
        ${maxParallelExpr},
        COALESCE(s.requires_staff, false)    AS requires_staff,
        COALESCE(s.requires_resource, false) AS requires_resource,
        ${requiresConfirmationExpr},
        s.availability_basis                AS availability_basis,
        COALESCE(s.is_active, true)         AS is_active,
        ${imageExpr},
        ${currencyExpr}
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
// Body: { tenantSlug | tenantId, name, description, duration_minutes, price,
//         slot_interval_minutes, max_consecutive_slots, max_parallel_bookings,
//         requires_staff, requires_resource, availability_basis, is_active }
// ---------------------------------------------------------------------------
router.post("/", requireAdmin, async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId,
      name,
      description,
      duration_minutes,
      // accept multiple names for backwards compatibility:
      price,
      price_amount,
      price_jd,
      slot_interval_minutes,
      max_consecutive_slots,
      max_parallel_bookings,
      requires_staff,
      requires_resource,
      requires_confirmation,
      availability_basis,
      is_active,
    } = req.body || {};

    const ab = normalizeAvailabilityBasis(availability_basis);
    if (availability_basis != null && availability_basis !== "" && ab == null) {
      return res.status(400).json({ error: "Invalid availability_basis" });
    }

    if (!name || String(name).trim().length === 0) {
      return res.status(400).json({ error: "name is required" });
    }

    let tenant_id = tenantId ? Number(tenantId) : null;

    if (!tenant_id && tenantSlug) {
      const t = await db.query("SELECT id FROM tenants WHERE slug = $1", [String(tenantSlug)]);
      tenant_id = t.rows?.[0]?.id ?? null;
    }

    if (!tenant_id) {
      return res.status(400).json({ error: "tenantId or tenantSlug is required" });
    }

    const svcCols = await getServicesColumns();

    // Build INSERT dynamically so it never breaks during schema cleanup
    const cols = [];
    const vals = [];
    const params = [];

    const add = (col, val) => {
      cols.push(col);
      params.push(val);
      vals.push(`$${params.length}`);
    };

    add("tenant_id", tenant_id);
    add("name", String(name).trim());

    if (svcCols.has("description")) add("description", description == null ? null : String(description).trim());
    if (svcCols.has("duration_minutes")) add("duration_minutes", duration_minutes == null ? null : Number(duration_minutes));

    // Price: your current schema uses price_amount.
    // Accept legacy fields (price, price_jd) to avoid breaking older UIs.
    const incomingPrice =
      price_amount !== undefined ? price_amount : price !== undefined ? price : price_jd;
    if (incomingPrice !== undefined) {
      if (svcCols.has("price_amount")) add("price_amount", incomingPrice == null ? null : Number(incomingPrice));
      else if (svcCols.has("price")) add("price", incomingPrice == null ? null : Number(incomingPrice));
    }

    if (svcCols.has("slot_interval_minutes")) add("slot_interval_minutes", slot_interval_minutes == null ? null : Number(slot_interval_minutes));
    if (svcCols.has("max_consecutive_slots")) add("max_consecutive_slots", max_consecutive_slots == null ? null : Number(max_consecutive_slots));
    else if (svcCols.has("max_consecutive_slots")) add("max_consecutive_slots", max_consecutive_slots == null ? null : Number(max_consecutive_slots));

    // Parallel: write to max_parallel_bookings if present, else legacy max_parallel
    if (svcCols.has("max_parallel_bookings")) add("max_parallel_bookings", max_parallel_bookings == null ? null : Number(max_parallel_bookings));
    else if (svcCols.has("max_parallel")) add("max_parallel", max_parallel_bookings == null ? null : Number(max_parallel_bookings));

    if (svcCols.has("requires_staff")) add("requires_staff", !!requires_staff);
    if (svcCols.has("requires_resource")) add("requires_resource", !!requires_resource);
    if (svcCols.has("requires_confirmation")) {
      add("requires_confirmation", requires_confirmation == null ? false : !!requires_confirmation);
    }
    if (svcCols.has("availability_basis")) add("availability_basis", ab);
    if (svcCols.has("is_active")) add("is_active", is_active == null ? true : !!is_active);

    const q = `
      INSERT INTO services (${cols.join(", ")})
      VALUES (${vals.join(", ")})
      RETURNING *
    `;

    const { rows } = await db.query(q, params);
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error creating service:", err);
    return res.status(500).json({ error: "Failed to create service" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/services/:id
// Admin-only update (used by Owner Setup UI)
// Body: any of { name, description, duration_minutes, price, slot_interval_minutes,
//                max_consecutive_slots, max_parallel_bookings,
//                requires_staff, requires_resource, availability_basis, is_active }
// ---------------------------------------------------------------------------
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid id" });

    const {
      name,
      description,
      duration_minutes,
      price,
      price_amount,
      price_jd,
      slot_interval_minutes,
      max_consecutive_slots,
      max_parallel_bookings,
      requires_staff,
      requires_resource,
      requires_confirmation,
      availability_basis,
      is_active,
    } = req.body || {};

    const ab = normalizeAvailabilityBasis(availability_basis);
    if (availability_basis != null && availability_basis !== "" && ab == null) {
      return res.status(400).json({ error: "Invalid availability_basis" });
    }

    const svcCols = await getServicesColumns();

    const sets = [];
    const params = [];
    const add = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (name != null && svcCols.has("name")) add("name", String(name).trim());
    if (description !== undefined && svcCols.has("description")) add("description", description == null ? null : String(description).trim());
    if (duration_minutes !== undefined && svcCols.has("duration_minutes")) add("duration_minutes", duration_minutes == null ? null : Number(duration_minutes));

    const incomingPrice =
      price_amount !== undefined ? price_amount : price !== undefined ? price : price_jd;
    if (incomingPrice !== undefined) {
      if (svcCols.has("price_amount")) add("price_amount", incomingPrice == null ? null : Number(incomingPrice));
      else if (svcCols.has("price")) add("price", incomingPrice == null ? null : Number(incomingPrice));
    }

    if (slot_interval_minutes !== undefined && svcCols.has("slot_interval_minutes"))
      add("slot_interval_minutes", slot_interval_minutes == null ? null : Number(slot_interval_minutes));

    if (max_consecutive_slots !== undefined) {
      if (svcCols.has("max_consecutive_slots")) add("max_consecutive_slots", max_consecutive_slots == null ? null : Number(max_consecutive_slots));
      else if (svcCols.has("max_consecutive_slots")) add("max_consecutive_slots", max_consecutive_slots == null ? null : Number(max_consecutive_slots));
    }

    if (max_parallel_bookings !== undefined) {
      if (svcCols.has("max_parallel_bookings")) add("max_parallel_bookings", max_parallel_bookings == null ? null : Number(max_parallel_bookings));
      else if (svcCols.has("max_parallel")) add("max_parallel", max_parallel_bookings == null ? null : Number(max_parallel_bookings));
    }

    if (requires_staff !== undefined && svcCols.has("requires_staff")) add("requires_staff", !!requires_staff);
    if (requires_resource !== undefined && svcCols.has("requires_resource")) add("requires_resource", !!requires_resource);
    if (requires_confirmation !== undefined && svcCols.has("requires_confirmation")) {
      add("requires_confirmation", !!requires_confirmation);
    }
    if (availability_basis !== undefined && svcCols.has("availability_basis")) add("availability_basis", ab);
    if (is_active !== undefined && svcCols.has("is_active")) add("is_active", !!is_active);

    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    params.push(id);
    const q = `
      UPDATE services
      SET ${sets.join(", ")}
      WHERE id = $${params.length}
      RETURNING *
    `;

    const { rows } = await db.query(q, params);
    if (!rows.length) return res.status(404).json({ error: "not found" });

    return res.json(rows[0]);
  } catch (err) {
    console.error("Error updating service:", err);
    return res.status(500).json({ error: "Failed to update service" });
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

      const key = `tenants/${safeTenant}/services/${id}-${safeService}-${Date.now()}`;

      const { url } = await uploadFileToR2({
        filePath: tmpPath,
        contentType: req.file.mimetype,
        key,
      });

      const svcCols = await getServicesColumns();

      // Prefer image_url if present, else legacy photo_url
      const sets = [];
      const params = [id, url];
      if (svcCols.has("image_url")) sets.push("image_url = $2");
      else if (svcCols.has("photo_url")) sets.push("photo_url = $2");
      else return res.status(500).json({ error: "DB misconfigured: no image_url/photo_url column" });

      // Optional: image_key if present
      if (svcCols.has("image_key")) {
        params.push(key);
        sets.push(`image_key = $${params.length}`);
      }

      const q = `
        UPDATE services
        SET ${sets.join(", ")}
        WHERE id = $1
        RETURNING *
      `;

      const out = await db.query(q, params);
      return res.json(out.rows[0]);
    } catch (err) {
      console.error("Error uploading service image:", err);
      return res.status(500).json({ error: "Failed to upload image" });
    } finally {
      try { await fsp.unlink(tmpPath); } catch {}
    }
  }
);

module.exports = router;
