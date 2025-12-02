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

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
