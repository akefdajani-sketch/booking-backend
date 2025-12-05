// index.js — BookFlow backend (multi-tenant booking API)

const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Booking backend API is running" });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getTenantIdFromSlug(tenantSlug) {
  if (!tenantSlug) return null;
  const tRes = await db.query("SELECT id FROM tenants WHERE slug = $1", [
    tenantSlug,
  ]);
  if (tRes.rows.length === 0) return null;
  return tRes.rows[0].id;
}

// join a booking row with tenant / service / staff / resource names
async function loadJoinedBookingById(id) {
  const q = `
    SELECT
      b.id,
      b.tenant_id,
      t.slug          AS tenant_slug,
      t.name          AS tenant,
      b.service_id,
      s.name          AS service_name,
      b.staff_id,
      st.name         AS staff_name,
      b.resource_id,
      r.name          AS resource_name,
      b.start_time,
      b.duration_minutes,
      b.customer_name,
      b.customer_phone,
      b.customer_email,
      b.status
    FROM bookings b
    JOIN tenants t ON b.tenant_id = t.id
    LEFT JOIN services  s  ON b.service_id  = s.id
    LEFT JOIN staff     st ON b.staff_id    = st.id
    LEFT JOIN resources r  ON b.resource_id = r.id
    WHERE b.id = $1
  `;
  const result = await db.query(q, [id]);
  return result.rows[0] || null;
}

// conflict check: overlapping time for same staff or same resource
async function checkConflicts({
  tenantId,
  staffId,
  resourceId,
  startTime,
  durationMinutes,
}) {
  const conflicts = { staffConflict: null, resourceConflict: null };

  const start = startTime;
  const dur = durationMinutes || 60;

  // For overlap: existing.start < newEnd AND (existing.start + existing.dur) > newStart
  const endExpr =
    "b.start_time + (COALESCE(b.duration_minutes, 60) || ' minutes')::interval";
  const newEndExpr = "($2::timestamptz + ($3 || ' minutes')::interval)";

  if (staffId) {
    const qs = `
      SELECT b.id, b.start_time, b.duration_minutes
      FROM bookings b
      WHERE
        b.tenant_id = $1
        AND b.staff_id = $4
        AND b.status <> 'cancelled'
        AND b.start_time < ${newEndExpr}
        AND ${endExpr} > $2::timestamptz
      ORDER BY b.start_time ASC
      LIMIT 1
    `;
    const rs = await db.query(qs, [tenantId, start, dur, staffId]);
    if (rs.rows.length > 0) {
      conflicts.staffConflict = rs.rows[0];
    }
  }

  if (resourceId) {
    const qr = `
      SELECT b.id, b.start_time, b.duration_minutes
      FROM bookings b
      WHERE
        b.tenant_id = $1
        AND b.resource_id = $4
        AND b.status <> 'cancelled'
        AND b.start_time < ${newEndExpr}
        AND ${endExpr} > $2::timestamptz
      ORDER BY b.start_time ASC
      LIMIT 1
    `;
    const rr = await db.query(qr, [tenantId, start, dur, resourceId]);
    if (rr.rows.length > 0) {
      conflicts.resourceConflict = rr.rows[0];
    }
  }

  return conflicts;
}

/* 🔽🔽🔽  ADD THE AVAILABILITY HELPERS + ROUTE RIGHT HERE 🔽🔽🔽 */

function parseHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return { h: h || 0, m: m || 0 };
}

function formatLabelFromMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const h12 = ((hours + 11) % 12) + 1;
  const mm = String(minutes).padStart(2, "0");
  return `${h12}:${mm} ${period}`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function rangesOverlap(startA, endA, startB, endB) {
  return !(endA <= startB || endB <= startA);
}

// GET /api/availability
app.get("/api/availability", async (req, res) => {
  try {
    const { tenantSlug, serviceId, date, staffId, resourceId } = req.query;

    if (!tenantSlug || !serviceId || !date) {
      return res.status(400).json({
        error: "Missing required query params (tenantSlug, serviceId, date).",
      });
    }

    const tenantId = await getTenantIdFromSlug(tenantSlug);
    if (!tenantId) {
      return res.status(400).json({ error: "Unknown tenantSlug." });
    }

    // 1) Load service to know duration & requirements
    const svcRes = await db.query(
      "SELECT * FROM services WHERE id = $1 AND tenant_id = $2",
      [serviceId, tenantId]
    );
    if (svcRes.rows.length === 0) {
      return res.status(404).json({ error: "Service not found for tenant." });
    }
    const svc = svcRes.rows[0];

    const requiresStaff = !!svc.requires_staff;
    const requiresResource = !!svc.requires_resource;

    const durationMinutes =
      svc.duration_minutes && Number(svc.duration_minutes) > 0
        ? Number(svc.duration_minutes)
        : 60;

    const slotIntervalMinutes =
      svc.slot_interval_minutes && Number(svc.slot_interval_minutes) > 0
        ? Number(svc.slot_interval_minutes)
        : durationMinutes; // for now align with duration

    const maxParallel =
      svc.max_parallel_bookings && Number(svc.max_parallel_bookings) > 0
        ? Number(svc.max_parallel_bookings)
        : 1;

    if (requiresStaff && !staffId) {
      return res
        .status(400)
        .json({ error: "This service requires selecting a staff member." });
    }
    if (requiresResource && !resourceId) {
      return res
        .status(400)
        .json({ error: "This service requires selecting a resource." });
    }

    // 2) Working hours – **local time**, not UTC
    let openHHMM = "08:00";
    let closeHHMM = "23:00";

    try {
      const day = new Date(date + "T00:00:00").getDay(); // 0-6 local time
      const whRes = await db.query(
        `
        SELECT open_time, close_time
        FROM tenant_hours
        WHERE tenant_id = $1 AND day_of_week = $2 AND is_open = true
        LIMIT 1
        `,
        [tenantId, day]
      );
      if (whRes.rows.length > 0) {
        openHHMM = whRes.rows[0].open_time || openHHMM;
        closeHHMM = whRes.rows[0].close_time || closeHHMM;
      }
    } catch (e) {
      console.warn("tenant_hours lookup failed, using fallback hours", e);
    }

    const { h: openH, m: openM } = parseHHMM(openHHMM);
    const { h: closeH, m: closeM } = parseHHMM(closeHHMM);

    // Day anchor in LOCAL time (no "Z")
    const dayStart = new Date(date + "T00:00:00");
    const openDate = new Date(dayStart);
    openDate.setHours(openH, openM, 0, 0);
    const closeDate = new Date(dayStart);
    closeDate.setHours(closeH, closeM, 0, 0);

    // 3) Load bookings for that day (ignore cancelled)
    const bookingsRes = await db.query(
      `
      SELECT id, service_id, staff_id, resource_id, start_time, duration_minutes
      FROM bookings
      WHERE tenant_id = $1
        AND status <> 'cancelled'
        AND start_time::date = $2::date
      `,
      [tenantId, date]
    );
    const bookings = bookingsRes.rows || [];

    // 4) Generate slots and check conflicts
    const slots = [];
    let cursor = new Date(openDate);

    while (cursor < closeDate) {
      const slotStart = new Date(cursor);
      const slotEnd = addMinutes(slotStart, durationMinutes);
      if (slotEnd > closeDate) break;

      let conflicts = 0;

      for (const b of bookings) {
        const bStart = new Date(b.start_time); // JS will convert to local time
        const bEnd = addMinutes(
          bStart,
          b.duration_minutes && Number(b.duration_minutes) > 0
            ? Number(b.duration_minutes)
            : durationMinutes
        );

        if (!rangesOverlap(slotStart, slotEnd, bStart, bEnd)) continue;

        const bStaffId = b.staff_id ? String(b.staff_id) : null;
        const bResourceId = b.resource_id ? String(b.resource_id) : null;

        if (!requiresStaff && !requiresResource) {
          // capacity/service-only mode
          if (String(b.service_id) === String(serviceId)) conflicts += 1;
        } else if (requiresStaff && !requiresResource) {
          // staff-only
          if (staffId && bStaffId === String(staffId)) conflicts += 1;
        } else if (!requiresStaff && requiresResource) {
          // resource-only
          if (resourceId && bResourceId === String(resourceId)) conflicts += 1;
        } else {
          // staff AND resource
          let clash = false;
          if (staffId && bStaffId === String(staffId)) clash = true;
          if (resourceId && bResourceId === String(resourceId)) clash = true;
          if (clash) conflicts += 1;
        }
      }

      const available =
        !requiresStaff && !requiresResource
          ? conflicts < maxParallel
          : conflicts === 0;

      const minutesFromMidnight =
        slotStart.getHours() * 60 + slotStart.getMinutes();
      const label = formatLabelFromMinutes(minutesFromMidnight);
      const hh = String(slotStart.getHours()).padStart(2, "0");
      const mm = String(slotStart.getMinutes()).padStart(2, "0");

      slots.push({
        time: `${hh}:${mm}`,
        label,
        available,
      });

      cursor = addMinutes(cursor, slotIntervalMinutes);
    }

    res.json({ slots, durationMinutes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to compute availability." });
  }
});

/* 🔼🔼🔼  END OF AVAILABILITY BLOCK 🔼🔼🔼 */



// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

// GET /api/tenants
app.get("/api/tenants", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        id,
        slug,
        name,
        kind,
        timezone,
        logo_url,
        cover_image_url,
        created_at
      FROM tenants
      ORDER BY name ASC
      `
    );
    res.json({ tenants: result.rows });
  } catch (err) {
    console.error("Error loading tenants:", err);
    res.status(500).json({ error: "Failed to load tenants" });
  }
});

// ---------------------------------------------------------------------------
// Tenant settings (logo, cover, etc.)
// ---------------------------------------------------------------------------

// GET /api/tenant-settings?tenantSlug=&tenantId=
app.patch("/api/tenant-settings", async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId,
      logoUrl,
      logo_url,
      coverImageUrl,
      cover_image_url,
      name,
      kind,
    } = req.body || {};

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    // Accept both camelCase and snake_case
    const effectiveLogoUrl =
      typeof logoUrl !== "undefined" ? logoUrl : logo_url;
    const effectiveCoverUrl =
      typeof coverImageUrl !== "undefined" ? coverImageUrl : cover_image_url;

    const fields = [];
    const params = [];
    let idx = 1;

    if (typeof effectiveLogoUrl !== "undefined") {
      fields.push(`logo_url = $${idx++}`);
      params.push(effectiveLogoUrl || null);
    }
    if (typeof effectiveCoverUrl !== "undefined") {
      fields.push(`cover_image_url = $${idx++}`);
      params.push(effectiveCoverUrl || null);
    }
    if (typeof name !== "undefined") {
      fields.push(`name = $${idx++}`);
      params.push(name || null);
    }
    if (typeof kind !== "undefined") {
      fields.push(`kind = $${idx++}`);
      params.push(kind || null);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No fields to update." });
    }

    params.push(resolvedTenantId);

    const q = `
      UPDATE tenants
      SET ${fields.join(", ")}
      WHERE id = $${idx}
      RETURNING id, slug, name, kind, timezone, logo_url, cover_image_url
    `;

    const result = await db.query(q, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tenant not found." });
    }

    res.json({ tenant: result.rows[0] });
  } catch (err) {
    console.error("Error updating tenant settings:", err);
    res.status(500).json({ error: "Failed to update tenant settings." });
  }
});

// ---------------------------------------------------------------------------
// Tenant working hours
// ---------------------------------------------------------------------------

// GET /api/tenant-hours?tenantSlug=&tenantId=
app.get("/api/tenant-hours", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;
    let resolvedTenantId = tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    const result = await db.query(
      `
      SELECT
        id,
        day_of_week,
        open_time,
        close_time,
        is_closed
      FROM tenant_hours
      WHERE tenant_id = $1
      ORDER BY day_of_week ASC
      `,
      [resolvedTenantId]
    );

    res.json({ hours: result.rows });
  } catch (err) {
    console.error("Error loading tenant hours:", err);
    res.status(500).json({ error: "Failed to load tenant hours." });
  }
});

// POST /api/tenant-hours
// Body: { tenantSlug? | tenantId?, dayOfWeek, openTime?, closeTime?, isClosed? }
app.post("/api/tenant-hours", async (req, res) => {
  try {
    const { tenantSlug, tenantId, dayOfWeek, openTime, closeTime, isClosed } =
      req.body || {};

    if (
      typeof dayOfWeek !== "number" ||
      dayOfWeek < 0 ||
      dayOfWeek > 6
    ) {
      return res
        .status(400)
        .json({ error: "dayOfWeek must be 0–6 (0 = Sunday)." });
    }

    let resolvedTenantId = tenantId || null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    const result = await db.query(
      `
      INSERT INTO tenant_hours (tenant_id, day_of_week, open_time, close_time, is_closed)
      VALUES ($1, $2, $3::time, $4::time, COALESCE($5, FALSE))
      ON CONFLICT (tenant_id, day_of_week)
      DO UPDATE SET
        open_time  = EXCLUDED.open_time,
        close_time = EXCLUDED.close_time,
        is_closed  = EXCLUDED.is_closed
      RETURNING id, tenant_id, day_of_week, open_time, close_time, is_closed
      `,
      [
        resolvedTenantId,
        dayOfWeek,
        openTime || null,
        closeTime || null,
        typeof isClosed === "boolean" ? isClosed : false,
      ]
    );

    res.json({ hour: result.rows[0] });
  } catch (err) {
    console.error("Error saving tenant hours:", err);
    res.status(500).json({ error: "Failed to save tenant hours." });
  }
});


// ---------------------------------------------------------------------------
// Tenant working hours (save + sync to tenant_hours table)
// ---------------------------------------------------------------------------

app.post("/api/tenants/:tenantId/working-hours", async (req, res) => {
  const rawTenantId = req.params.tenantId;
  const tenantId = Number(rawTenantId);
  const { workingHours } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: "Invalid tenant id." });
  }
  if (!workingHours || typeof workingHours !== "object") {
    return res.status(400).json({ error: "Missing workingHours." });
  }

  // map keys sun..sat -> 0..6 (or whatever you use)
  const dayKeyToIndex = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };

  try {
    await db.query("BEGIN");

    // 1) store JSON on tenants.working_hours (for the UI)
    await db.query(
      "UPDATE tenants SET working_hours = $1 WHERE id = $2",
      [JSON.stringify(workingHours), tenantId]
    );

    // 2) rebuild tenant_hours table (for availability)
    await db.query("DELETE FROM tenant_hours WHERE tenant_id = $1", [tenantId]);

    const values = [];
    const params = [];
    let p = 1;

    for (const [key, conf] of Object.entries(workingHours)) {
      const idx = dayKeyToIndex[key];
      if (idx === undefined) continue;

      const c = conf as any;
      const closed = !!c.closed;

      // only insert rows for open days
      if (!closed) {
        const open = c.open || "10:00";
        const close = c.close || "22:00";

        values.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
        );
        params.push(
          tenantId,
          idx,
          true,        // is_open
          open,
          close
        );
      }
    }

    if (values.length) {
      await db.query(
        `
        INSERT INTO tenant_hours
          (tenant_id, day_of_week, is_open, open_time, close_time)
        VALUES
          ${values.join(",")}
        `,
        params
      );
    }

    await db.query("COMMIT");
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error saving working hours:", err);
    try {
      await db.query("ROLLBACK");
    } catch (_) {}
    return res.status(500).json({ error: "Failed to save working hours." });
  }
});




// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

// GET /api/services?tenantSlug=&tenantId=
app.get("/api/services", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;
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

    // only active services
    if (where) {
      where += " AND s.is_active = TRUE";
    } else {
      where = "WHERE s.is_active = TRUE";
    }

    const q = `
      SELECT
        s.id,
        s.tenant_id,
        t.slug   AS tenant_slug,
        t.name   AS tenant,
        s.name,
        s.duration_minutes,
        s.price_jd,
        s.requires_staff,
        s.requires_resource,
        s.is_active
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
app.post("/api/services", async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId,
      name,
      durationMinutes,
      priceJd,
      requiresStaff,
      requiresResource,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Service name is required." });
    }

    let resolvedTenantId = tenantId || null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenantSlug." });
      }
    }

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    const dur =
      durationMinutes && Number(durationMinutes) > 0
        ? Number(durationMinutes)
        : null;
    const price =
      typeof priceJd === "number"
        ? priceJd
        : priceJd && Number(priceJd) >= 0
        ? Number(priceJd)
        : null;

    const reqStaff = !!requiresStaff;
    const reqResource = !!requiresResource;

    const insert = await db.query(
      `
      INSERT INTO services
        (tenant_id, name, duration_minutes, price_jd, is_active, requires_staff, requires_resource)
      VALUES
        ($1, $2, $3, $4, TRUE, $5, $6)
      RETURNING id, tenant_id, name, duration_minutes, price_jd, requires_staff, requires_resource;
      `,
      [resolvedTenantId, name.trim(), dur, price, reqStaff, reqResource]
    );

    const row = insert.rows[0];

    const joined = await db.query(
      `
      SELECT
        s.id,
        s.tenant_id,
        t.slug   AS tenant_slug,
        t.name   AS tenant,
        s.name,
        s.duration_minutes,
        s.price_jd,
        s.requires_staff,
        s.requires_resource,
        s.is_active
      FROM services s
      JOIN tenants t ON s.tenant_id = t.id
      WHERE s.id = $1;
      `,
      [row.id]
    );

    res.status(201).json({ service: joined.rows[0] });
  } catch (err) {
    console.error("Error creating service:", err);
    res.status(500).json({ error: "Failed to create service" });
  }
});

// DELETE /api/services/:id  (soft delete)
app.delete("/api/services/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid service id." });
  }

  try {
    const result = await db.query(
      `
      UPDATE services
      SET is_active = FALSE
      WHERE id = $1
      RETURNING id;
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Service not found." });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting service:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to delete service" });
  }
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

// GET /api/staff?tenantSlug=&tenantId=
app.get("/api/staff", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;
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

    // only active staff
    if (where) {
      where += " AND s.is_active = TRUE";
    } else {
      where = "WHERE s.is_active = TRUE";
    }

    const q = `
      SELECT
        s.id,
        s.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant,
        s.name,
        s.role,
        s.is_active,
        s.created_at
      FROM staff s
      JOIN tenants t ON s.tenant_id = t.id
      ${where}
      ORDER BY t.name ASC, s.name ASC
    `;
    const result = await db.query(q, params);
    res.json({ staff: result.rows });
  } catch (err) {
    console.error("Error loading staff:", err);
    res.status(500).json({ error: "Failed to load staff" });
  }
});

// POST /api/staff
// Body: { tenantSlug?, tenantId?, name, role? }
app.post("/api/staff", async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, role } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Staff name is required." });
    }

    let resolvedTenantId = tenantId || null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenantSlug." });
      }
    }

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    const insert = await db.query(
      `
      INSERT INTO staff (tenant_id, name, role, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id, tenant_id, name, role, is_active, created_at;
      `,
      [resolvedTenantId, name.trim(), role ? String(role).trim() : null]
    );

    const row = insert.rows[0];

    const joined = await db.query(
      `
      SELECT
        s.id,
        s.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant,
        s.name,
        s.role,
        s.is_active,
        s.created_at
      FROM staff s
      JOIN tenants t ON s.tenant_id = t.id
      WHERE s.id = $1;
      `,
      [row.id]
    );

    res.status(201).json({ staff: joined.rows[0] });
  } catch (err) {
    console.error("Error creating staff:", err);
    res.status(500).json({ error: "Failed to create staff" });
  }
});

// DELETE /api/staff/:id  (soft delete)
app.delete("/api/staff/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid staff id." });
  }

  try {
    const result = await db.query(
      `
      UPDATE staff
      SET is_active = FALSE
      WHERE id = $1
      RETURNING id;
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Staff not found." });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting staff:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to delete staff" });
  }
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

// GET /api/resources?tenantSlug=&tenantId=
app.get("/api/resources", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;
    let where = "";
    const params = [];
    let idx = 1;

    if (tenantId) {
      params.push(Number(tenantId));
      where = `WHERE r.tenant_id = $${idx}`;
      idx++;
    } else if (tenantSlug) {
      params.push(tenantSlug);
      where = `WHERE t.slug = $${idx}`;
      idx++;
    }

    // only active resources
    if (where) {
      where += " AND r.is_active = TRUE";
    } else {
      where = "WHERE r.is_active = TRUE";
    }

    const q = `
      SELECT
        r.id,
        r.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant,
        r.name,
        r.type,
        r.is_active,
        r.created_at
      FROM resources r
      JOIN tenants t ON r.tenant_id = t.id
      ${where}
      ORDER BY t.name ASC, r.name ASC
    `;
    const result = await db.query(q, params);
    res.json({ resources: result.rows });
  } catch (err) {
    console.error("Error loading resources:", err);
    res.status(500).json({ error: "Failed to load resources" });
  }
});

// POST /api/resources
// Body: { tenantSlug?, tenantId?, name, type? }
app.post("/api/resources", async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, type } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Resource name is required." });
    }

    let resolvedTenantId = tenantId || null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenantSlug." });
      }
    }

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    const insert = await db.query(
      `
      INSERT INTO resources (tenant_id, name, type, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id, tenant_id, name, type, is_active, created_at;
      `,
      [resolvedTenantId, name.trim(), type ? String(type).trim() : null]
    );

    const row = insert.rows[0];

    const joined = await db.query(
      `
      SELECT
        r.id,
        r.tenant_id,
        t.slug AS tenant_slug,
        t.name AS tenant,
        r.name,
        r.type,
        r.is_active,
        r.created_at
      FROM resources r
      JOIN tenants t ON r.tenant_id = t.id
      WHERE r.id = $1;
      `,
      [row.id]
    );

    res.status(201).json({ resource: joined.rows[0] });
  } catch (err) {
    console.error("Error creating resource:", err);
    res.status(500).json({ error: "Failed to create resource" });
  }
});

// DELETE /api/resources/:id  (soft delete)
app.delete("/api/resources/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid resource id." });
  }

  try {
    const result = await db.query(
      `
      UPDATE resources
      SET is_active = FALSE
      WHERE id = $1
      RETURNING id;
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Resource not found." });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting resource:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to delete resource" });
  }
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

// GET /api/customers?tenantSlug=&tenantId=
app.get("/api/customers", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenant." });
      }
    }

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    const customersRes = await db.query(
      `
      SELECT
        id,
        tenant_id,
        name,
        phone,
        email,
        notes
      FROM customers
      WHERE tenant_id = $1
      ORDER BY id DESC
      `,
      [resolvedTenantId]
    );

    res.json({ customers: customersRes.rows });
  } catch (err) {
    console.error("Error loading customers:", err);
    res.status(500).json({ error: "Failed to load customers." });
  }
});

// POST /api/customers
// Body: { tenantSlug?, tenantId?, name, phone?, email?, notes? }
app.post("/api/customers", async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, phone, email, notes } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Customer name is required." });
    }

    // Normalise values
    const cleanName = name.trim();
    const cleanPhone =
      typeof phone === "string" && phone.trim().length > 0
        ? phone.trim()
        : null;
    const cleanEmail =
      typeof email === "string" && email.trim().length > 0
        ? email.trim()
        : null;
    const cleanNotes =
      typeof notes === "string" && notes.trim().length > 0
        ? notes.trim()
        : null;

    // Resolve tenant
    let resolvedTenantId =
      typeof tenantId === "number" ? tenantId : tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenantSlug." });
      }
    }

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    // Try to find an existing customer by phone/email
    let existing = null;
    if (cleanPhone || cleanEmail) {
      const existingRes = await db.query(
        `
        SELECT id, tenant_id, name, phone, email, notes, created_at, updated_at
        FROM customers
        WHERE tenant_id = $1
          AND (
            ($2::text IS NOT NULL AND phone = $2::text) OR
            ($3::text IS NOT NULL AND email = $3::text)
          )
        LIMIT 1
        `,
        [resolvedTenantId, cleanPhone, cleanEmail]
      );

      if (existingRes.rows.length > 0) {
        existing = existingRes.rows[0];
      }
    }

    // If customer exists, optionally update name/notes
    if (existing) {
      let updated = existing;

      if (
        (cleanNotes && cleanNotes !== (existing.notes || "")) ||
        (cleanName && cleanName !== existing.name)
      ) {
        const updateRes = await db.query(
          `
          UPDATE customers
          SET
            name = $1,
            notes = $2,
            updated_at = NOW()
          WHERE id = $3
          RETURNING id, tenant_id, name, phone, email, notes, created_at, updated_at
          `,
          [cleanName, cleanNotes || existing.notes, existing.id]
        );
        updated = updateRes.rows[0];
      }

      return res.json({ customer: updated, existing: true });
    }

    // Insert new customer
    const insertRes = await db.query(
      `
      INSERT INTO customers (tenant_id, name, phone, email, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, tenant_id, name, phone, email, notes, created_at, updated_at
      `,
      [resolvedTenantId, cleanName, cleanPhone, cleanEmail, cleanNotes]
    );

    res.status(201).json({ customer: insertRes.rows[0], existing: false });
  } catch (err) {
    console.error("Error creating customer:", err);
    res.status(500).json({ error: "Failed to create customer." });
  }
});

// DELETE /api/customers/:id
app.delete("/api/customers/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid customer id." });
  }

  try {
    const result = await db.query(
      `
      DELETE FROM customers
      WHERE id = $1
      RETURNING id;
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Customer not found." });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting customer:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to delete customer." });
  }
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

// GET /api/bookings?tenantId=&tenantSlug=
app.get("/api/bookings", async (req, res) => {
  try {
    const { tenantId, tenantSlug } = req.query;
    let resolvedTenantId = tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenant." });
      }
    }

    const params = [];
    let where = "";
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      where = "WHERE b.tenant_id = $1";
    }

    const q = `
      SELECT
        b.id,
        b.tenant_id,
        t.slug          AS tenant_slug,
        t.name          AS tenant,
        b.service_id,
        s.name          AS service_name,
        b.staff_id,
        st.name         AS staff_name,
        b.resource_id,
        r.name          AS resource_name,
        b.start_time,
        b.duration_minutes,
        b.customer_name,
        b.customer_phone,
        b.customer_email,
        b.status
      FROM bookings b
      JOIN tenants t ON b.tenant_id = t.id
      LEFT JOIN services  s  ON b.service_id  = s.id
      LEFT JOIN staff     st ON b.staff_id    = st.id
      LEFT JOIN resources r  ON b.resource_id = r.id
      ${where}
      ORDER BY b.start_time DESC
    `;

    const result = await db.query(q, params);
    res.json({ bookings: result.rows });
  } catch (err) {
    console.error("Error loading bookings:", err);
    res.status(500).json({ error: "Failed to load bookings" });
  }
});

// POST /api/bookings
// Flexible endpoint used by both owner + public pages
app.post("/api/bookings", async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId,
      serviceId,
      startTime,
      durationMinutes,
      customerName,
      customerPhone,
      customerEmail,
      staffId,
      resourceId,
    } = req.body;

    if (!customerName || !customerName.trim() || !startTime) {
      return res.status(400).json({
        error: "Missing required fields (customerName, startTime).",
      });
    }

    let resolvedTenantId = tenantId || null;
    let resolvedServiceId = serviceId || null;
    let duration =
      durationMinutes && Number(durationMinutes) > 0
        ? Number(durationMinutes)
        : null;

    // Resolve tenant from slug if needed
    if (!resolvedTenantId && tenantSlug) {
      const tid = await getTenantIdFromSlug(tenantSlug);
      if (!tid) {
        return res.status(400).json({ error: "Unknown tenant." });
      }
      resolvedTenantId = tid;
    }

    // If serviceId is provided, verify it and infer tenant if still missing
    if (resolvedServiceId) {
      const sRes = await db.query(
        `
        SELECT id, tenant_id, duration_minutes, requires_staff, requires_resource
        FROM services
        WHERE id = $1
        `,
        [resolvedServiceId]
      );

      if (sRes.rows.length === 0) {
        return res.status(400).json({ error: "Unknown service." });
      }

      const s = sRes.rows[0];

      if (resolvedTenantId && s.tenant_id !== resolvedTenantId) {
        return res
          .status(400)
          .json({ error: "Service does not belong to this tenant." });
      }

      if (!resolvedTenantId) {
        resolvedTenantId = s.tenant_id;
      }

      // if duration not provided, default to service duration
      if (!duration) {
        duration = s.duration_minutes || 60;
      }
    }

    if (!resolvedTenantId) {
      return res.status(400).json({
        error: "You must provide tenantSlug or tenantId or serviceId.",
      });
    }

    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime." });
    }
    if (!duration) {
      duration = 60; // fallback if nothing else
    }

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    // conflict checks for staff/resource
    const conflicts = await checkConflicts({
      tenantId: resolvedTenantId,
      staffId: staff_id,
      resourceId: resource_id,
      startTime: start.toISOString(),
      durationMinutes: duration,
    });

    if (conflicts.staffConflict || conflicts.resourceConflict) {
      return res.status(409).json({
        error: "Booking conflicts with an existing booking.",
        conflicts,
      });
    }

    // Insert booking
    const insert = await db.query(
      `
      INSERT INTO bookings
        (tenant_id, service_id, staff_id, resource_id, start_time, duration_minutes,
         customer_name, customer_phone, customer_email, status)
      VALUES
        ($1, $2, $3, $4, $5, $6,
         $7, $8, $9, 'pending')
      RETURNING id;
      `,
      [
        resolvedTenantId,
        resolvedServiceId,
        staff_id,
        resource_id,
        start.toISOString(),
        duration,
        customerName.trim(),
        customerPhone || null,
        customerEmail || null,
      ]
    );

    const bookingId = insert.rows[0].id;

    // Auto-create / upsert customer (non-blocking for booking success)
    if (resolvedTenantId && (customerPhone || customerEmail)) {
      try {
        const existingRes = await db.query(
          `
          SELECT id
          FROM customers
          WHERE tenant_id = $1
            AND (
              ($2 IS NOT NULL AND phone = $2) OR
              ($3 IS NOT NULL AND email = $3)
            )
          LIMIT 1
          `,
          [resolvedTenantId, customerPhone || null, customerEmail || null]
        );

        if (existingRes.rows.length === 0) {
          await db.query(
            `
            INSERT INTO customers (tenant_id, name, phone, email)
            VALUES ($1, $2, $3, $4)
            `,
            [
              resolvedTenantId,
              customerName.trim(),
              customerPhone || null,
              customerEmail || null,
            ]
          );
        } else {
          // Optional: keep name fresh (no updated_at column in your table)
          await db.query(
            `
            UPDATE customers
            SET name = $1
            WHERE id = $2
            `,
            [customerName.trim(), existingRes.rows[0].id]
          );
        }
      } catch (custErr) {
        console.error("Error upserting customer from booking:", custErr);
        // Don't fail the booking if customer insert fails
      }
    }

    const joined = await loadJoinedBookingById(bookingId);
    res.status(201).json({ booking: joined });
  } catch (err) {
    console.error("Error creating booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

// POST /api/bookings/:id/status
app.post("/api/bookings/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;

    const allowed = ["pending", "confirmed", "cancelled"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }

    await db.query(
      `
      UPDATE bookings
      SET status = $1
      WHERE id = $2
      `,
      [status, id]
    );

    const joined = await loadJoinedBookingById(id);
    if (!joined) {
      return res.status(404).json({ error: "Booking not found." });
    }

    res.json({ booking: joined });
  } catch (err) {
    console.error("Error updating booking status:", err);
    res.status(500).json({ error: "Failed to update booking status" });
  }
});

// DELETE /api/bookings/:id
app.delete("/api/bookings/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid booking id." });
  }

  try {
    const result = await db.query(
      `
      DELETE FROM bookings
      WHERE id = $1
      RETURNING id;
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found." });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting booking:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to delete booking" });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
