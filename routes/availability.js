// routes/availability.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// --- helpers ---
function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISODate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function parseYMD(dateStr) {
  // expects YYYY-MM-DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  // create a UTC date at midnight
  return new Date(Date.UTC(y, mo - 1, da, 0, 0, 0, 0));
}

function minutesSinceMidnight(timeStr) {
  // expects HH:MM or HH:MM:SS
  if (!timeStr) return null;
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeStr);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh * 60 + mm;
}

function addMinutesUTC(d, min) {
  return new Date(d.getTime() + min * 60 * 1000);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  // [start, end)
  return aStart < bEnd && bStart < aEnd;
}

// --- route ---
router.get("/", async (req, res) => {
  try {
    const tenantSlug = String(req.query.tenantSlug || req.query.slug || "").trim();
    const dateStr = String(req.query.date || "").trim();

    const serviceIdRaw = req.query.serviceId ?? req.query.service_id;
    const staffIdRaw = req.query.staffId ?? req.query.staff_id;
    const resourceIdRaw = req.query.resourceId ?? req.query.resource_id;

    const serviceId = serviceIdRaw != null && serviceIdRaw !== "" ? Number(serviceIdRaw) : null;
    const staffId = staffIdRaw != null && staffIdRaw !== "" ? Number(staffIdRaw) : null;
    const resourceId = resourceIdRaw != null && resourceIdRaw !== "" ? Number(resourceIdRaw) : null;

    if (!tenantSlug) return res.status(400).json({ error: "tenantSlug is required" });
    if (!dateStr) return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });

    const day = parseYMD(dateStr);
    if (!day) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

    // 1) tenant id
    const t = await pool.query(
      `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
      [tenantSlug]
    );
    if (!t.rows.length) return res.status(404).json({ error: "Tenant not found" });
    const tenantId = t.rows[0].id;

    // 2) service rules (duration + requires flags) - SELECT * to avoid missing-column crashes
    let durationMinutes = 60;
    let requiresResource = false;
    let requiresStaff = false;

    if (serviceId) {
      const s = await pool.query(
        `SELECT * FROM services WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [serviceId, tenantId]
      );
      if (!s.rows.length) return res.status(404).json({ error: "Service not found" });

      const row = s.rows[0];

      // support multiple legacy column names safely:
      const dm =
        row.duration_minutes ??
        row.duration ??
        row.minutes ??
        row.slot_minutes ??
        null;

      if (dm != null && Number(dm) > 0) durationMinutes = Number(dm);

      requiresResource = Boolean(row.requires_resource ?? row.requiresResource ?? false);
      requiresStaff = Boolean(row.requires_staff ?? row.requiresStaff ?? false);
    }

    // enforce requirements (if service says so)
    if (requiresResource && !resourceId) return res.json({ slots: [] });
    if (requiresStaff && !staffId) return res.json({ slots: [] });

    // 3) tenant hours for day_of_week (0=Sun ... 6=Sat)
    const dow = day.getUTCDay();
    const th = await pool.query(
      `SELECT open_time, close_time, is_closed
       FROM tenant_hours
       WHERE tenant_id = $1 AND day_of_week = $2
       LIMIT 1`,
      [tenantId, dow]
    );

    if (!th.rows.length) return res.json({ slots: [] });

    const { open_time, close_time, is_closed } = th.rows[0];
    if (is_closed) return res.json({ slots: [] });

    const openMin = minutesSinceMidnight(open_time);
    const closeMin = minutesSinceMidnight(close_time);

    if (openMin == null || closeMin == null) return res.json({ slots: [] });

    // if close <= open => crosses midnight
    const crossesMidnight = closeMin <= openMin;

    const openDT = addMinutesUTC(day, openMin);
    const closeDT = crossesMidnight
      ? addMinutesUTC(addMinutesUTC(day, 24 * 60), closeMin)
      : addMinutesUTC(day, closeMin);

    // 4) fetch bookings that could overlap this window (single query)
    // filter by resource/staff if provided (priority: resource, else staff, else tenant-wide)
    const whereParts = [`tenant_id = $1`];
    const params = [tenantId];

    // status filtering (if your table has status; if not, this won’t break)
    // We'll do it safely by not referencing missing columns in SQL.
    // So: no "status != 'cancelled'" in SQL.

    if (resourceId) {
      params.push(resourceId);
      whereParts.push(`resource_id = $${params.length}`);
    } else if (staffId) {
      params.push(staffId);
      whereParts.push(`staff_id = $${params.length}`);
    }

    // bounding window
    params.push(openDT.toISOString());
    whereParts.push(`start_time < $${params.length}::timestamptz`);
    params.push(closeDT.toISOString());
    whereParts.push(`(start_time + (duration_minutes || ' minutes')::interval) > $${params.length}::timestamptz`);

    // NOTE: This assumes bookings.duration_minutes exists (your UI/backend already uses it).
    // If your bookings table uses a different column name, tell me and I’ll adjust.
    const bq = await pool.query(
      `SELECT start_time, duration_minutes
       FROM bookings
       WHERE ${whereParts.join(" AND ")}`,
      params
    );

    const bookings = bq.rows
      .map((r) => {
        const st = new Date(r.start_time);
        const dur = Number(r.duration_minutes || 0);
        const en = addMinutesUTC(st, dur);
        return { st, en };
      })
      .filter((x) => !Number.isNaN(x.st.getTime()) && !Number.isNaN(x.en.getTime()));

    // 5) generate slots (15-min steps)
    const STEP_MIN = 15;
    const slots = [];

    for (let cur = new Date(openDT); cur.getTime() + durationMinutes * 60 * 1000 <= closeDT.getTime(); cur = addMinutesUTC(cur, STEP_MIN)) {
      const end = addMinutesUTC(cur, durationMinutes);

      const isTaken = bookings.some((b) => overlaps(cur, end, b.st, b.en));

      const hh = pad2(cur.getUTCHours());
      const mm = pad2(cur.getUTCMinutes());

      slots.push({
        time: `${hh}:${mm}`,          // what your UI renders
        available: !isTaken,          // for grey-out behavior
        start_time: cur.toISOString() // optional (useful later)
      });
    }

    return res.json({ slots });
  } catch (err) {
    console.error("GET /api/availability error:", err);
    return res.status(500).json({ error: "Failed to load availability." });
  }
});

module.exports = router;
