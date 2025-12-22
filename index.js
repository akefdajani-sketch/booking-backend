// index.js — BookFlow backend (multi-tenant booking API)

const express = require("express");
const cors = require("cors");
const db = require("./db");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  "https://booking-frontend-psi.vercel.app",
  "http://localhost:3000",
];

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, origin);
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());


// ---------------------------------------------------------------------------
// File uploads (tenant logos)
// ---------------------------------------------------------------------------

const uploadDir = path.join(__dirname, "uploads");

// ensure uploads directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// store files as: uploads/tenant-<id>-logo.ext
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base =
      path.basename(file.originalname || "file", ext).replace(/\s+/g, "-") ||
      "file";
    const unique = Date.now();
    cb(null, `${base.toLowerCase()}-${unique}${ext || ""}`);
  },
});

const upload = multer({ storage });

// serve the uploads folder statically so frontend can show the logo
app.use("/uploads", express.static(uploadDir));

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

    // ---------------------------------------------------------------------
    // 2) Working hours from tenant_hours (your schema: is_closed)
    //    Stored as open_time / close_time (time), + is_closed (bool).
    //    If close_time = 00:00, we treat it as midnight (24:00).
    // ---------------------------------------------------------------------

    let openHHMM = "08:00";
    let closeHHMM = "23:00";

    try {
      const day = new Date(date + "T00:00:00").getDay(); // 0-6 local
      const whRes = await db.query(
        `
        SELECT open_time, close_time, is_closed
        FROM tenant_hours
        WHERE tenant_id = $1 AND day_of_week = $2
        LIMIT 1
        `,
        [tenantId, day]
      );
      if (whRes.rows.length > 0) {
        const row = whRes.rows[0];

        if (row.is_closed) {
          // Day is marked closed → no slots at all
          return res.json({ slots: [], durationMinutes });
        }

        if (row.open_time) {
          // Convert "10:00:00" -> "10:00"
          openHHMM = row.open_time.toString().slice(0, 5);
        }
        if (row.close_time) {
          // Convert "00:00:00" -> "00:00"
          closeHHMM = row.close_time.toString().slice(0, 5);
        }
      }
    } catch (e) {
      console.warn("tenant_hours lookup failed, using fallback hours", e);
    }

    const { h: openH, m: openM } = parseHHMM(openHHMM);
    const { h: closeHRaw, m: closeM } = parseHHMM(closeHHMM);

    let openMinutes = openH * 60 + openM;
    let closeMinutes = closeHRaw * 60 + closeM;

    // If close <= open, assume it means "until midnight" (24:00)
    // e.g. open = 10:00 (600), close = 00:00 (0) -> treat close = 24:00 (1440)
    if (closeMinutes <= openMinutes) {
      closeMinutes += 24 * 60;
    }

    // ---------------------------------------------------------------------
    // 3) Load bookings for that day (ignore cancelled).
    //    DB stores start_time in UTC; Birdie is UTC+3 (Jordan), so we apply
    //    a fixed +180 minute conversion to local.
    // ---------------------------------------------------------------------

    const bookingsRes = await db.query(
      `
      SELECT
        id,
        service_id,
        staff_id,
        resource_id,
        start_time,
        duration_minutes,
        EXTRACT(HOUR   FROM start_time) AS start_hour,
        EXTRACT(MINUTE FROM start_time) AS start_minute
      FROM bookings
      WHERE tenant_id = $1
        AND status <> 'cancelled'
        AND start_time::date = $2::date
      `,
      [tenantId, date]
    );
    const bookings = bookingsRes.rows || [];

    // DB times assumed UTC; Jordan is UTC+3 -> +180 minutes
    const DB_TO_LOCAL_OFFSET_MIN = 3 * 60;

    function minutesOverlap(aStart, aEnd, bStart, bEnd) {
      return aStart < bEnd && bStart < aEnd;
    }

    // ---------------------------------------------------------------------
    // 4) Generate slots and check conflicts (all integer minutes)
    // ---------------------------------------------------------------------

    const slots = [];

    for (
      let slotStartMinutes = openMinutes;
      slotStartMinutes + durationMinutes <= closeMinutes;
      slotStartMinutes += slotIntervalMinutes
    ) {
      const slotEndMinutes = slotStartMinutes + durationMinutes;
      let conflicts = 0;

      for (const b of bookings) {
        // Minutes from midnight in DB timezone (likely UTC)
        const dbStartMinutes =
          Number(b.start_hour) * 60 + Number(b.start_minute);

        // Convert to local Jordan minutes (UTC+3)
        const bStartMinutes =
          (dbStartMinutes + DB_TO_LOCAL_OFFSET_MIN + 1440) % 1440;

        const bDuration =
          b.duration_minutes && Number(b.duration_minutes) > 0
            ? Number(b.duration_minutes)
            : durationMinutes;

        const bEndMinutes = bStartMinutes + bDuration;

        if (
          !minutesOverlap(
            slotStartMinutes,
            slotEndMinutes,
            bStartMinutes,
            bEndMinutes
          )
        ) {
          continue;
        }

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

      const label = formatLabelFromMinutes(slotStartMinutes % (24 * 60));
      const hh = String(Math.floor(slotStartMinutes / 60) % 24).padStart(2, "0");
      const mm = String(slotStartMinutes % 60).padStart(2, "0");

      slots.push({
        time: `${hh}:${mm}`, // "HH:MM" for the frontend
        label,               // e.g. "10:00 AM", "11:00 PM"
        available,
      });
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
// Tenant working hours — writes directly to tenant_hours table
// ---------------------------------------------------------------------------
app.post("/api/tenants/:tenantId/working-hours", async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const body = req.body || {};
  const workingHours = body.workingHours;

  if (!tenantId) {
    return res.status(400).json({ error: "Invalid tenant id." });
  }
  if (!workingHours || typeof workingHours !== "object") {
    return res.status(400).json({ error: "Missing workingHours." });
  }

  // UI keys -> database day_of_week
  const mapDay = {
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

    // wipe old hours
    await db.query("DELETE FROM tenant_hours WHERE tenant_id = $1", [tenantId]);

    const entries = Object.entries(workingHours);
    let params = [];
    let values = [];
    let p = 1;

    for (const [key, conf] of entries) {
      const idx = mapDay[key];
      if (idx === undefined) continue;

      const isClosed = !!conf.closed;

      // open_time & close_time only stored when NOT closed
      const openTime = isClosed ? null : conf.open;
      const closeTime = isClosed ? null : conf.close;

      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        tenantId,
        idx,
        openTime,
        closeTime,
        isClosed // matches your "is_closed" column
      );
    }

    if (values.length > 0) {
      const sql = `
        INSERT INTO tenant_hours
          (tenant_id, day_of_week, open_time, close_time, is_closed)
        VALUES ${values.join(",")}
      `;
      await db.query(sql, params);
    }

    await db.query("COMMIT");
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error saving working hours:", err);
    await db.query("ROLLBACK");
    return res.status(500).json({
      error: "Failed to save working hours.",
      details: err.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Tenant logo upload
// ---------------------------------------------------------------------------

app.post(
  "/api/tenants/:tenantId/logo",
  upload.single("file"), // field name is "file" from FormData
  async (req, res) => {
    try {
      const tenantId = Number(req.params.tenantId);
      if (!tenantId) {
        return res.status(400).json({ error: "Invalid tenant id." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      // URL that frontend can use to display the logo
      const logoUrl = `/uploads/${req.file.filename}`;

      // save to tenants table (make sure there is a logo_url column)
      await db.query(
        "UPDATE tenants SET logo_url = $1 WHERE id = $2",
        [logoUrl, tenantId]
      );

      // return updated tenant so frontend can refresh UI
      const tRes = await db.query(
        "SELECT id, slug, name, kind, logo_url FROM tenants WHERE id = $1",
        [tenantId]
      );

      const tenant = tRes.rows[0] || null;

      return res.json({
        ok: true,
        logoUrl,
        tenant,
      });
    } catch (err) {
      console.error("Error uploading tenant logo:", err);
      return res
        .status(500)
        .json({ error: "Failed to upload logo.", details: String(err) });
    }
  }
);

// ---------------------------------------------------------------------------
// Service image upload
// ---------------------------------------------------------------------------

app.post(
  "/api/services/:id/image",
  upload.single("file"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) {
        return res.status(400).json({ error: "Invalid service id." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      const imageUrl = `/uploads/${req.file.filename}`;

      await db.query(
        "UPDATE services SET image_url = $1 WHERE id = $2",
        [imageUrl, id]
      );

      const sRes = await db.query("SELECT * FROM services WHERE id = $1", [id]);
      return res.json({ ok: true, imageUrl, service: sRes.rows[0] });
    } catch (err) {
      console.error("Service image upload error:", err);
      return res.status(500).json({ error: "Failed to upload image." });
    }
  }
);

// ---------------------------------------------------------------------------
// Staff avatar upload
// ---------------------------------------------------------------------------

app.post(
  "/api/staff/:id/image",
  upload.single("file"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) {
        return res.status(400).json({ error: "Invalid staff id." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      const avatarUrl = `/uploads/${req.file.filename}`;

      await db.query(
        "UPDATE staff SET avatar_url = $1 WHERE id = $2",
        [avatarUrl, id]
      );

      const sRes = await db.query("SELECT * FROM staff WHERE id = $1", [id]);
      return res.json({ ok: true, avatarUrl, staff: sRes.rows[0] });
    } catch (err) {
      console.error("Staff image upload error:", err);
      return res.status(500).json({ error: "Failed to upload image." });
    }
  }
);

// ---------------------------------------------------------------------------
// Resource image upload
// ---------------------------------------------------------------------------

app.post(
  "/api/resources/:id/image",
  upload.single("file"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) {
        return res.status(400).json({ error: "Invalid resource id." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      const imageUrl = `/uploads/${req.file.filename}`;

      await db.query(
        "UPDATE resources SET image_url = $1 WHERE id = $2",
        [imageUrl, id]
      );

      const rRes = await db.query("SELECT * FROM resources WHERE id = $1", [id]);
      return res.json({ ok: true, imageUrl, resource: rRes.rows[0] });
    } catch (err) {
      console.error("Resource image upload error:", err);
      return res.status(500).json({ error: "Failed to upload image." });
    }
  }
);

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
// Service image upload
// ---------------------------------------------------------------------------

app.post(
  "/api/services/:serviceId/image",
  upload.single("file"), // field name must match FormData.append(...)
  async (req, res) => {
    try {
      const serviceId = Number(req.params.serviceId);
      if (!serviceId) {
        return res.status(400).json({ error: "Invalid service id." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
      }

      const imageUrl = `/uploads/${req.file.filename}`;

      // Save URL in services table
      await db.query(
        "UPDATE services SET image_url = $1 WHERE id = $2",
        [imageUrl, serviceId]
      );

      // Return updated service so frontend can refresh UI
      const sRes = await db.query(
        "SELECT id, tenant_id, name, duration_minutes, price, needs_staff, needs_resource, image_url FROM services WHERE id = $1",
        [serviceId]
      );

      const service = sRes.rows[0] || null;

      return res.json({ ok: true, imageUrl, service });
    } catch (err) {
      console.error("Error uploading service image:", err);
      return res
        .status(500)
        .json({ error: "Failed to upload image.", details: String(err) });
    }
  }
);


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
      customerId,          // NEW: optional existing customer id
    } = req.body || {};

    if (!customerName || !customerName.trim() || !startTime) {
      return res.status(400).json({
        error: "Missing required fields (customerName, startTime).",
      });
    }

    let resolvedTenantId =
      typeof tenantId === "number"
        ? tenantId
        : tenantId
        ? Number(tenantId)
        : null;
    let resolvedServiceId =
      typeof serviceId === "number"
        ? serviceId
        : serviceId
        ? Number(serviceId)
        : null;

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

    // If serviceId is provided, verify it and infer tenant / duration
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
        return res.status(400).json({ error: "Unknown serviceId." });
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
        duration =
          s.duration_minutes && Number(s.duration_minutes) > 0
            ? Number(s.duration_minutes)
            : 60;
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
      duration = 60; // final fallback
    }

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    // ---------------------------------------------------------------------
    // 1) Check conflicts for staff/resource
    // ---------------------------------------------------------------------
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

    // ---------------------------------------------------------------------
    // 2) Resolve / upsert customer and get a customer_id
    // ---------------------------------------------------------------------
    const cleanName = customerName.trim();
    const cleanPhone =
      typeof customerPhone === "string" && customerPhone.trim().length
        ? customerPhone.trim()
        : null;
    const cleanEmail =
      typeof customerEmail === "string" && customerEmail.trim().length
        ? customerEmail.trim()
        : null;

    let finalCustomerId = null;

    // 2a) If client sent an explicit customerId, verify it belongs to this tenant
    if (customerId) {
      const cid = Number(customerId);
      const cRes = await db.query(
        `
        SELECT id
        FROM customers
        WHERE id = $1 AND tenant_id = $2
        `,
        [cid, resolvedTenantId]
      );
      if (cRes.rows.length > 0) {
        finalCustomerId = cRes.rows[0].id;
      }
    }

    // 2b) If no valid customerId yet but we have phone/email, upsert
    if (!finalCustomerId && (cleanPhone || cleanEmail)) {
      const existingRes = await db.query(
        `
        SELECT id, name
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
        // Existing customer – update name if changed
        finalCustomerId = existingRes.rows[0].id;

        if (
          cleanName &&
          cleanName.length &&
          cleanName !== existingRes.rows[0].name
        ) {
          await db.query(
            `
            UPDATE customers
            SET name = $1, updated_at = NOW()
            WHERE id = $2
            `,
            [cleanName, finalCustomerId]
          );
        }
      } else {
        // Insert new customer
        const insertCust = await db.query(
          `
          INSERT INTO customers (tenant_id, name, phone, email, notes, created_at)
          VALUES ($1, $2, $3, $4, NULL, NOW())
          RETURNING id
          `,
          [resolvedTenantId, cleanName, cleanPhone, cleanEmail]
        );
        finalCustomerId = insertCust.rows[0].id;
      }
    }

    // ---------------------------------------------------------------------
    // 3) Insert booking with customer_id
    // ---------------------------------------------------------------------
    const insert = await db.query(
      `
      INSERT INTO bookings
        (tenant_id, service_id, staff_id, resource_id, start_time, duration_minutes,
         customer_id, customer_name, customer_phone, customer_email, status)
      VALUES
        ($1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, 'pending')
      RETURNING id;
      `,
      [
        resolvedTenantId,
        resolvedServiceId,
        staff_id,
        resource_id,
        start.toISOString(),
        duration,
        finalCustomerId,                   // NEW: link to customers table
        cleanName,
        cleanPhone,
        cleanEmail,
      ]
    );

    const bookingId = insert.rows[0].id;
    const firstLetter = (customerName || "X").trim().charAt(0).toUpperCase() || "X";
    
    // created date in YYYYMMDD (use server time)
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    
    // Example format: A-<tenantId>-<serviceId>-<YYYYMMDD>-<bookingId>
    const bookingCode = `${firstLetter}-${resolvedTenantId || 0}-${resolvedServiceId || 0}-${ymd}-${bookingId}`;
    
    await db.query(
      `UPDATE bookings SET booking_code = $1 WHERE id = $2`,
      [bookingCode, bookingId]
    );

    const joined = await loadJoinedBookingById(bookingId);
    return res.status(201).json({ booking: joined });
  } catch (err) {
    console.error("Error creating booking:", err);
    return res
      .status(500)
      .json({ error: "Failed to create booking.", details: String(err) });
  }
});

// DELETE /api/bookings/:id
// "Cancel" booking (soft delete) by setting status='cancelled'
app.delete("/api/bookings/:id", async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    if (!bookingId) return res.status(400).send("Invalid booking id");

    // allow tenantSlug/customerId in body OR query
    const tenantSlug = req.body?.tenantSlug || req.query?.tenantSlug;
    const customerIdRaw = req.body?.customerId || req.query?.customerId;
    const customerId = customerIdRaw ? Number(customerIdRaw) : null;

    if (!tenantSlug) return res.status(400).send("tenantSlug is required");

    const tenantId = await getTenantIdFromSlug(tenantSlug);
    if (!tenantId) return res.status(400).send("Unknown tenantSlug");

    // Ensure booking belongs to tenant (and customer if provided)
    const check = await db.query(
      `
      SELECT id, customer_id
      FROM bookings
      WHERE id = $1 AND tenant_id = $2
      `,
      [bookingId, tenantId]
    );

    if (check.rows.length === 0) return res.status(404).send("Booking not found");

    const bookingCustomerId = row.customer_id; // could be null

    if (
      customerId &&
      bookingCustomerId !== null &&
      Number(bookingCustomerId) !== Number(customerId)
    ) {
      return res.status(403).send("Not allowed");
    }


    await db.query(
      `
      UPDATE bookings
      SET status = 'cancelled'
      WHERE id = $1 AND tenant_id = $2
      `,
      [bookingId, tenantId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/bookings/:id error:", err);
    return res.status(500).send("Failed to cancel booking");
  }
});


// ---------------------------------------------------------------------------
// Memberships (Plans + Customer Memberships + Ledger)
// ---------------------------------------------------------------------------

// GET /api/membership-plans?tenantSlug=...
app.get("/api/membership-plans", async (req, res) => {
  try {
    const { tenantSlug } = req.query;
    if (!tenantSlug) {
      return res.status(400).json({ error: "tenantSlug is required." });
    }

    const tenantId = await getTenantIdFromSlug(tenantSlug);
    if (!tenantId) return res.status(400).json({ error: "Unknown tenantSlug." });

    const q = `
      SELECT
        id,
        tenant_id,
        name,
        description,
        billing_type,
        price,
        currency,
        included_minutes,
        included_uses,
        validity_days,
        is_active,
        created_at,
        updated_at
      FROM membership_plans
      WHERE tenant_id = $1 AND is_active = TRUE
      ORDER BY id DESC
    `;
    const r = await db.query(q, [tenantId]);
    return res.json({ plans: r.rows });
  } catch (err) {
    console.error("GET /api/membership-plans error:", err);
    return res.status(500).json({ error: "Failed to load membership plans." });
  }
});

// GET /api/customer-memberships?tenantSlug=...&customerId=...
// Returns plan_name joined for display
app.get("/api/customer-memberships", async (req, res) => {
  try {
    const { tenantSlug, customerId } = req.query;

    if (!tenantSlug || !customerId) {
      return res.status(400).json({ error: "tenantSlug and customerId are required." });
    }

    const tenantId = await getTenantIdFromSlug(tenantSlug);
    if (!tenantId) return res.status(400).json({ error: "Unknown tenantSlug." });

    const cid = Number(customerId);
    if (!cid) return res.status(400).json({ error: "Invalid customerId." });

    // make sure customer belongs to tenant
    const cRes = await db.query(
      "SELECT id FROM customers WHERE id = $1 AND tenant_id = $2",
      [cid, tenantId]
    );
    if (cRes.rows.length === 0) {
      return res.status(404).json({ error: "Customer not found for tenant." });
    }

    const q = `
      SELECT
        cm.id,
        cm.tenant_id,
        cm.customer_id,
        cm.plan_id,
        cm.status,
        cm.start_at,
        cm.end_at,
        cm.minutes_remaining,
        cm.uses_remaining,
        mp.name AS plan_name
      FROM customer_memberships cm
      JOIN membership_plans mp ON mp.id = cm.plan_id
      WHERE cm.tenant_id = $1 AND cm.customer_id = $2
      ORDER BY cm.id DESC
    `;
    const r = await db.query(q, [tenantId, cid]);
    return res.json({ memberships: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships error:", err);
    return res.status(500).json({ error: "Failed to load memberships." });
  }
});

// POST /api/customer-memberships/subscribe
app.post("/api/customer-memberships/subscribe", async (req, res) => {
  const client = await db.connect();

  try {
    const { tenantSlug, customerId, planId } = req.body;

    if (!tenantSlug || !customerId || !planId) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Resolve tenant
    const tenantRes = await client.query(
      "SELECT id FROM tenants WHERE slug = $1",
      [tenantSlug]
    );
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) {
      return res.status(400).json({ error: "Invalid tenantSlug." });
    }

    // Validate customer belongs to tenant
    const custRes = await client.query(
      "SELECT id FROM customers WHERE id = $1 AND tenant_id = $2",
      [customerId, tenantId]
    );
    if (custRes.rows.length === 0) {
      return res.status(400).json({ error: "Customer does not belong to tenant." });
    }

    // Load membership plan
    const planRes = await client.query(
      `SELECT id, name, included_minutes, included_uses, validity_days
       FROM membership_plans
       WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
      [planId, tenantId]
    );
    if (planRes.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or inactive plan." });
    }

    const plan = planRes.rows[0];
    const minutes = plan.included_minutes ?? 0;
    const uses = plan.included_uses ?? 0;
    const validityDays = plan.validity_days;

    await client.query("BEGIN");

    // Expire existing memberships
    await client.query(
      `UPDATE customer_memberships
       SET status = 'expired', end_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND customer_id = $2 AND status = 'active'`,
      [tenantId, customerId]
    );

    // Create new membership
    const membershipRes = await client.query(
      `INSERT INTO customer_memberships
       (tenant_id, customer_id, plan_id, status,
        start_at, end_at,
        minutes_remaining, uses_remaining,
        created_at, updated_at)
       VALUES
       ($1, $2, $3, 'active',
        NOW(),
        NOW() + ($6 || ' days')::interval,
        $4, $5,
        NOW(), NOW())
       RETURNING *`,
      [
        tenantId,
        customerId,
        planId,
        minutes,
        uses,
        validityDays,
      ]
    );

    const membership = membershipRes.rows[0];

    // Ledger entry (grant)
    await client.query(
      `INSERT INTO membership_ledger
       (tenant_id, customer_membership_id, type,
        minutes_delta, uses_delta, note, created_at)
       VALUES
       ($1, $2, 'grant', $3, $4, $5, NOW())`,
      [
        tenantId,
        membership.id,
        minutes,
        uses,
        `Initial grant for ${plan.name}`,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({ membership });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("SUBSCRIBE ERROR:", err.message, err);
    res.status(500).json({ error: "Failed to subscribe." });
  } finally {
    client.release();
  }
});


// GET /api/customer-memberships/:id/ledger?tenantSlug=...
app.get("/api/customer-memberships/:id/ledger", async (req, res) => {
  try {
    const { tenantSlug } = req.query;
    const membershipId = Number(req.params.id);

    if (!tenantSlug) return res.status(400).json({ error: "tenantSlug is required." });
    if (!membershipId) return res.status(400).json({ error: "Invalid membership id." });

    const tenantId = await getTenantIdFromSlug(tenantSlug);
    if (!tenantId) return res.status(400).json({ error: "Unknown tenantSlug." });

    // ensure membership belongs to tenant
    const mRes = await db.query(
      "SELECT id FROM customer_memberships WHERE id = $1 AND tenant_id = $2",
      [membershipId, tenantId]
    );
    if (mRes.rows.length === 0) {
      return res.status(404).json({ error: "Membership not found for tenant." });
    }

    const q = `
      SELECT
        id,
        created_at,
        type,
        minutes_delta,
        uses_delta,
        note,
        booking_id
      FROM membership_ledger
      WHERE tenant_id = $1 AND customer_membership_id = $2
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const r = await db.query(q, [tenantId, membershipId]);
    return res.json({ ledger: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships/:id/ledger error:", err);
    return res.status(500).json({ error: "Failed to load ledger." });
  }
});



// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
