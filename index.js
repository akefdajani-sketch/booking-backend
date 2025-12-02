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
      t.name          AS tenant_name,
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
    JOIN tenants t   ON b.tenant_id   = t.id
    LEFT JOIN services  s  ON b.service_id  = s.id
    LEFT JOIN staff     st ON b.staff_id    = st.id
    LEFT JOIN resources r  ON b.resource_id = r.id
    WHERE b.id = $1
  `;
  const res = await db.query(q, [id]);
  return res.rows[0] || null;
}

// Check for conflicts by staff / resource
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
  const newEndExpr = `$2::timestamptz + ($3 || ' minutes')::interval`;

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
        AND b.status NOT IN ('cancelled','deleted')
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
      SELECT id, slug, name, type
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

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId" });
    }

    const result = await db.query(
      `
      SELECT id, tenant_id, name, duration_minutes, price_jd,
             needs_staff, needs_resource
      FROM services
      WHERE tenant_id = $1 AND deleted_at IS NULL
      ORDER BY id ASC
      `,
      [resolvedTenantId]
    );
    res.json({ services: result.rows });
  } catch (err) {
    console.error("Error loading services:", err);
    res.status(500).json({ error: "Failed to load services" });
  }
});

// POST /api/services
app.post("/api/services", async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId,
      name,
      durationMinutes,
      priceJd,
      needsStaff,
      needsResource,
    } = req.body;

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId" });
    }

    if (!name || !durationMinutes) {
      return res.status(400).json({ error: "Missing name or duration." });
    }

    const result = await db.query(
      `
      INSERT INTO services
        (tenant_id, name, duration_minutes, price_jd, needs_staff, needs_resource)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      RETURNING id, tenant_id, name, duration_minutes, price_jd, needs_staff, needs_resource
      `,
      [
        resolvedTenantId,
        name,
        durationMinutes,
        priceJd || 0,
        !!needsStaff,
        !!needsResource,
      ]
    );

    res.status(201).json({ service: result.rows[0] });
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
    await db.query(
      `
      UPDATE services
      SET deleted_at = NOW()
      WHERE id = $1
      `,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting service:", err);
    res.status(500).json({ error: "Failed to delete service" });
  }
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

// GET /api/staff?tenantSlug=&tenantId=
app.get("/api/staff", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId" });
    }

    const result = await db.query(
      `
      SELECT id, tenant_id, name, role
      FROM staff
      WHERE tenant_id = $1 AND deleted_at IS NULL
      ORDER BY id ASC
      `,
      [resolvedTenantId]
    );
    res.json({ staff: result.rows });
  } catch (err) {
    console.error("Error loading staff:", err);
    res.status(500).json({ error: "Failed to load staff" });
  }
});

// POST /api/staff
app.post("/api/staff", async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, role } = req.body;

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId" });
    }

    if (!name) {
      return res.status(400).json({ error: "Missing staff name." });
    }

    const result = await db.query(
      `
      INSERT INTO staff (tenant_id, name, role)
      VALUES ($1, $2, $3)
      RETURNING id, tenant_id, name, role
      `,
      [resolvedTenantId, name, role || null]
    );

    res.status(201).json({ staff: result.rows[0] });
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
    await db.query(
      `
      UPDATE staff
      SET deleted_at = NOW()
      WHERE id = $1
      `,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting staff:", err);
    res.status(500).json({ error: "Failed to delete staff" });
  }
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

// GET /api/resources?tenantSlug=&tenantId=
app.get("/api/resources", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId" });
    }

    const result = await db.query(
      `
      SELECT id, tenant_id, name, type
      FROM resources
      WHERE tenant_id = $1 AND deleted_at IS NULL
      ORDER BY id ASC
      `,
      [resolvedTenantId]
    );
    res.json({ resources: result.rows });
  } catch (err) {
    console.error("Error loading resources:", err);
    res.status(500).json({ error: "Failed to load resources" });
  }
});

// POST /api/resources
app.post("/api/resources", async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, type } = req.body;

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId" });
    }

    if (!name) {
      return res.status(400).json({ error: "Missing resource name." });
    }

    const result = await db.query(
      `
      INSERT INTO resources (tenant_id, name, type)
      VALUES ($1, $2, $3)
      RETURNING id, tenant_id, name, type
      `,
      [resolvedTenantId, name, type || null]
    );

    res.status(201).json({ resource: result.rows[0] });
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
    await db.query(
      `
      UPDATE resources
      SET deleted_at = NOW()
      WHERE id = $1
      `,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting resource:", err);
    res.status(500).json({ error: "Failed to delete resource" });
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
      return res.status(400).json({ error: "Missing tenantSlug or tenantId." });
    }

    const result = await db.query(
      `
      SELECT
        id,
        tenant_id,
        name,
        phone,
        email,
        notes,
        created_at,
        updated_at
      FROM customers
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      `,
      [resolvedTenantId]
    );

    res.json({ customers: result.rows });
  } catch (err) {
    console.error("Error loading customers:", err);
    res.status(500).json({ error: "Failed to load customers" });
  }
});

// POST /api/customers
app.post("/api/customers", async (req, res) => {
  try {
    const { tenantSlug, tenantId, name, phone, email, notes } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Customer name is required." });
    }

    let resolvedTenantId = tenantId || null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
      if (!resolvedTenantId) {
        return res.status(400).json({ error: "Unknown tenantSlug." });
      }
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId." });
    }

    let existing = null;

    if (phone || email) {
      const existingRes = await db.query(
        `
        SELECT *
        FROM customers
        WHERE tenant_id = $1
          AND (phone = $2 OR email = $3)
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [resolvedTenantId, phone || null, email || null]
      );
      if (existingRes.rows.length > 0) {
        existing = existingRes.rows[0];
      }
    }

    if (existing) {
      let updated = existing;

      if (
        (notes && notes.trim() && notes.trim() !== (existing.notes || "")) ||
        (name && name.trim() && name.trim() !== existing.name)
      ) {
        const updateRes = await db.query(
          `
          UPDATE customers
          SET
            name = $1,
            notes = $2,
            updated_at = NOW()
          WHERE id = $3
          RETURNING *
          `,
          [name.trim(), notes || existing.notes, existing.id]
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
      RETURNING *
      `,
      [resolvedTenantId, name.trim(), phone || null, email || null, notes || null]
    );

    res.status(201).json({ customer: insertRes.rows[0], existing: false });
  } catch (err) {
    console.error("Error creating customer:", err);
    res.status(500).json({ error: "Failed to create customer." });
  }
}

// DELETE /api/customers/:id
app.delete("/api/customers/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid customer id." });
    }

    await db.query("DELETE FROM customers WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting customer:", err);
    res.status(500).json({ error: "Failed to delete customer" });
  }
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

// GET /api/bookings?tenantSlug=&tenantId=
app.get("/api/bookings", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId" });
    }

    const params = [resolvedTenantId];
    const where = "WHERE b.tenant_id = $1";

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

    if (!customerName || !startTime) {
      return res.status(400).json({
        error: "Missing required fields (customerName, startTime).",
      });
    }

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(tenantSlug);
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId." });
    }

    let resolvedServiceId = serviceId ? Number(serviceId) : null;

    let duration = 60;
    if (durationMinutes && Number(durationMinutes) > 0) {
      duration = Number(durationMinutes);
    } else if (resolvedServiceId) {
      const sRes = await db.query(
        "SELECT duration_minutes FROM services WHERE id = $1",
        [resolvedServiceId]
      );
      if (sRes.rows.length > 0 && sRes.rows[0].duration_minutes) {
        duration = sRes.rows[0].duration_minutes;
      }
    }

    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime" });
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

    // Upsert customer record for CRM
    try {
      if (customerName && (customerPhone || customerEmail)) {
        await db.query(
          `
          INSERT INTO customers (tenant_id, name, phone, email, notes)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (tenant_id, phone, email)
          DO UPDATE SET
            name = EXCLUDED.name,
            updated_at = NOW()
          `,
          [
            resolvedTenantId,
            customerName.trim(),
            customerPhone || null,
            customerEmail || null,
            null,
          ]
        );
      }
    } catch (err) {
      console.error("Failed to upsert customer from booking:", err);
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
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    // Hard delete (removes the row entirely)
    await db.query("DELETE FROM bookings WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting booking:", err);
    res.status(500).json({ error: "Failed to delete booking" });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
