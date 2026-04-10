// routes/services/crud.js
// GET/, POST/, PATCH/:id, DELETE/:id
// Mounted by routes/services.js

const db = require("../../db");
const { pool } = require("../../db");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const {
  resolveTenantFromServiceId, normalizeAvailabilityBasis, normalizeAllowMembership,
  getServicesColumns, getTenantsColumns, serviceHoursTableExists,
} = require("../../utils/servicesHelpers");
const { assertWithinPlanLimit } = require("../../utils/planEnforcement");


module.exports = function mount(router) {
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, includeInactive, categoryId } = req.query;

    // PR-3: pagination
    const limitRaw  = req.query.limit  ? Number(req.query.limit)  : 100;
    const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
    const limit  = Math.max(1, Math.min(500, Number.isFinite(limitRaw)  ? limitRaw  : 100));
    const offset = Math.max(0,              Number.isFinite(offsetRaw) ? offsetRaw : 0);

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
    const hasServiceHours = await serviceHoursTableExists();

    // PR-10: build soft-delete filter using already-loaded svcCols (no extra DB call)
    const softDeleteWhere = svcCols.has("deleted_at")
      ? whereSql
        ? whereSql + " AND s.deleted_at IS NULL"
        : "WHERE s.deleted_at IS NULL"
      : whereSql;

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

    const minConsecutiveExpr = svcCols.has("min_consecutive_slots")
      ? "s.min_consecutive_slots AS min_consecutive_slots"
      : "NULL::int AS min_consecutive_slots";

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

    const allowMembershipExpr = svcCols.has("allow_membership")
      ? "COALESCE(s.allow_membership, false) AS allow_membership"
      : "false::boolean AS allow_membership";

    // RENTAL-1: nightly rental expressions
    const bookingModeExpr = svcCols.has("booking_mode")
      ? "COALESCE(s.booking_mode, 'time_slots') AS booking_mode"
      : "'time_slots'::text AS booking_mode";
    const minNightsExpr = svcCols.has("min_nights")
      ? "COALESCE(s.min_nights, 1) AS min_nights"
      : "1::int AS min_nights";
    const maxNightsExpr = svcCols.has("max_nights")
      ? "s.max_nights AS max_nights"
      : "NULL::int AS max_nights";
    const checkinTimeExpr = svcCols.has("checkin_time")
      ? "COALESCE(s.checkin_time::text, '15:00') AS checkin_time"
      : "'15:00'::text AS checkin_time";
    const checkoutTimeExpr = svcCols.has("checkout_time")
      ? "COALESCE(s.checkout_time::text, '11:00') AS checkout_time"
      : "'11:00'::text AS checkout_time";
    const pricePerNightExpr = svcCols.has("price_per_night")
      ? "s.price_per_night AS price_per_night"
      : "NULL::numeric AS price_per_night";

    const q = `
      SELECT
        s.id,
        s.tenant_id,
        s.name,
        s.description,
        s.duration_minutes,
        ${priceExpr},
        ${slotIntervalExpr},
        ${minConsecutiveExpr},
        ${maxConsecutiveExpr},
        ${maxParallelExpr},
        COALESCE(s.requires_staff, false)    AS requires_staff,
        COALESCE(s.requires_resource, false) AS requires_resource,
        ${requiresConfirmationExpr},
        ${allowMembershipExpr},
        s.availability_basis                AS availability_basis,
        COALESCE(s.is_active, true)         AS is_active,
        ${imageExpr},
        ${currencyExpr},
        s.category_id,
        ${bookingModeExpr},
        ${minNightsExpr},
        ${maxNightsExpr},
        ${checkinTimeExpr},
        ${checkoutTimeExpr},
        ${pricePerNightExpr}
      FROM services s
      JOIN tenants t ON t.id = s.tenant_id
      ${softDeleteWhere}
      ORDER BY s.id DESC
    `;

    // Count for meta (uses same WHERE, no LIMIT)
    const countSql = `SELECT COUNT(*)::int AS total FROM services s JOIN tenants t ON t.id = s.tenant_id ${softDeleteWhere}`;
    const countResult = await db.query(countSql, params);
    const total = countResult.rows[0]?.total ?? 0;

    // Paginated data query
    const paginatedQ = q + `\n      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const { rows } = await db.query(paginatedQ, [...params, limit, offset]);

    // ---------------------------------------------------------------------------
    // Attach per-service available_hours (from service_hours table, migration 008).
    // This tells the booking UI which days-of-week each service runs on, so it
    // can disable the service in the dropdown when the chosen date doesn't match.
    // If the table doesn't exist yet (pre-migration env), we skip silently.
    // ---------------------------------------------------------------------------
    if (hasServiceHours && rows.length > 0) {
      const serviceIds = rows.map((r) => r.id);
      const { rows: hoursRows } = await db.query(
        `SELECT service_id, day_of_week, open_time::text AS open_time, close_time::text AS close_time
         FROM service_hours
         WHERE service_id = ANY($1)
         ORDER BY service_id, day_of_week`,
        [serviceIds]
      );
      // Group by service_id for O(n) attachment
      const hoursMap = {};
      for (const h of hoursRows) {
        if (!hoursMap[h.service_id]) hoursMap[h.service_id] = [];
        hoursMap[h.service_id].push({
          day_of_week: h.day_of_week,
          open_time: h.open_time,
          close_time: h.close_time,
        });
      }
      for (const row of rows) {
        row.available_hours = hoursMap[row.id] || [];
      }
    } else {
      // Ensure field is always present so frontend type is consistent
      for (const row of rows) {
        row.available_hours = [];
      }
    }

    return res.json({
      services: rows,
      meta: {
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      },
    });
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
router.post("/", requireTenant, requireAdminOrTenantRole("manager"), async (req, res) => {
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
      min_consecutive_slots,
      max_consecutive_slots,
      max_parallel_bookings,
      requires_staff,
      requires_resource,
      requires_confirmation,
      allow_membership,
      availability_basis,
      is_active,
      category_id,
      // RENTAL-1: nightly rental mode fields
      booking_mode,
      min_nights,
      max_nights,
      checkin_time,
      checkout_time,
      price_per_night,
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

    // Phase D1: enforce plan limits (creation guard)
    try {
      await assertWithinPlanLimit(tenant_id, "services");
    } catch (e) {
      return res.status(e.status || 403).json({
        error: e.message || "Plan limit reached",
        code: e.code || "PLAN_LIMIT_REACHED",
        kind: e.kind || "services",
        limit: e.limit,
        current: e.current,
        plan_code: e.plan_code,
      });
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
    if (svcCols.has("min_consecutive_slots")) add("min_consecutive_slots", min_consecutive_slots == null ? null : Number(min_consecutive_slots));
    if (svcCols.has("max_consecutive_slots")) {
      add("max_consecutive_slots", max_consecutive_slots == null ? null : Number(max_consecutive_slots));
    }

    // Parallel: write to max_parallel_bookings if present, else legacy max_parallel
    if (svcCols.has("max_parallel_bookings")) add("max_parallel_bookings", max_parallel_bookings == null ? null : Number(max_parallel_bookings));
    else if (svcCols.has("max_parallel")) add("max_parallel", max_parallel_bookings == null ? null : Number(max_parallel_bookings));

    if (svcCols.has("requires_staff")) add("requires_staff", !!requires_staff);
    if (svcCols.has("requires_resource")) add("requires_resource", !!requires_resource);
    if (svcCols.has("requires_confirmation")) {
      add("requires_confirmation", requires_confirmation == null ? false : !!requires_confirmation);
    }
    if (svcCols.has("allow_membership")) {
      const am = normalizeAllowMembership(allow_membership);
      if (am !== undefined) add("allow_membership", !!am);
    }
    if (svcCols.has("availability_basis")) add("availability_basis", ab);
    if (svcCols.has("is_active")) add("is_active", is_active == null ? true : !!is_active);
    // PR-CAT1: category assignment
    if (svcCols.has("category_id") && category_id !== undefined) {
      add("category_id", category_id == null ? null : Number(category_id));
    }
    // RENTAL-1: nightly rental columns (safe — only written if migration 023 has run)
    if (svcCols.has("booking_mode") && booking_mode !== undefined) {
      const safeMode = booking_mode === "nightly" ? "nightly" : "time_slots";
      add("booking_mode", safeMode);
      if (safeMode === "nightly") {
        if (svcCols.has("min_nights"))      add("min_nights",      min_nights      != null ? Math.max(1, Number(min_nights))  : 1);
        if (svcCols.has("max_nights"))      add("max_nights",      max_nights      != null ? Number(max_nights)               : null);
        if (svcCols.has("checkin_time"))    add("checkin_time",    checkin_time    || "15:00");
        if (svcCols.has("checkout_time"))   add("checkout_time",   checkout_time   || "11:00");
        if (svcCols.has("price_per_night")) add("price_per_night", price_per_night != null ? Number(price_per_night)          : null);
      }
    }

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
router.patch("/:id", resolveTenantFromServiceId, requireAdminOrTenantRole("manager"), async (req, res) => {
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
      min_consecutive_slots,
      max_consecutive_slots,
      max_parallel_bookings,
      requires_staff,
      requires_resource,
      requires_confirmation,
      allow_membership,
      availability_basis,
      is_active,
      category_id,
      // RENTAL-1: nightly rental mode fields
      booking_mode,
      min_nights,
      max_nights,
      checkin_time,
      checkout_time,
      price_per_night,
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

    if (min_consecutive_slots !== undefined && svcCols.has("min_consecutive_slots"))
      add("min_consecutive_slots", min_consecutive_slots == null ? null : Number(min_consecutive_slots));

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
    if (allow_membership !== undefined && svcCols.has("allow_membership")) {
      const am = normalizeAllowMembership(allow_membership);
      if (am !== undefined) add("allow_membership", !!am);
    }
    if (availability_basis !== undefined && svcCols.has("availability_basis")) add("availability_basis", ab);
    if (is_active !== undefined && svcCols.has("is_active")) add("is_active", !!is_active);
    if (category_id !== undefined && svcCols.has("category_id")) {
      add("category_id", category_id == null ? null : Number(category_id));
    }
    // RENTAL-1: nightly rental columns
    if (booking_mode !== undefined && svcCols.has("booking_mode")) {
      const safeMode = booking_mode === "nightly" ? "nightly" : "time_slots";
      add("booking_mode", safeMode);
    }
    if (min_nights !== undefined && svcCols.has("min_nights"))
      add("min_nights", min_nights == null ? 1 : Math.max(1, Number(min_nights)));
    if (max_nights !== undefined && svcCols.has("max_nights"))
      add("max_nights", max_nights == null ? null : Number(max_nights));
    if (checkin_time !== undefined && svcCols.has("checkin_time"))
      add("checkin_time", checkin_time || "15:00");
    if (checkout_time !== undefined && svcCols.has("checkout_time"))
      add("checkout_time", checkout_time || "11:00");
    if (price_per_night !== undefined && svcCols.has("price_per_night"))
      add("price_per_night", price_per_night == null ? null : Number(price_per_night));

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
router.delete("/:id", resolveTenantFromServiceId, requireAdminOrTenantRole("manager"), async (req, res) => {
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
};
