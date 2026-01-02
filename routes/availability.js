// routes/availability.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { getTenantIdFromSlug } = require("../utils/tenants");

// 15-min slot grid (matches your UI expectation)
const STEP_MIN = 15;

function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtHHMM(dateObj) {
  return `${pad2(dateObj.getUTCHours())}:${pad2(dateObj.getUTCMinutes())}`;
}
function addMinutes(d, minutes) {
  return new Date(d.getTime() + minutes * 60 * 1000);
}
function toUtcDateTime(dateStrYYYYMMDD, timeStrHHMMSS) {
  // Treat stored tenant_hours time as "local clock time" for that date,
  // but we compute in UTC consistently by building an ISO-like string.
  // dateStrYYYYMMDD is already normalized by frontend.
  const t = timeStrHHMMSS?.slice(0, 8) || "00:00:00";
  return new Date(`${dateStrYYYYMMDD}T${t}.000Z`);
}

/**
 * GET /api/availability?tenantSlug=...&date=YYYY-MM-DD&serviceId=...&staffId=...&resourceId=...
 *
 * Returns:
 * { timeSlots: ["10:00","10:15",...], times: [...], date, openTime, closeTime, stepMinutes, durationMinutes }
 */
router.get("/", async (req, res) => {
  try {
    const tenantSlug = String(req.query.tenantSlug || "").trim();
    const date = String(req.query.date || "").trim(); // YYYY-MM-DD
    const serviceId = Number(req.query.serviceId);
    const staffId = req.query.staffId !== undefined ? Number(req.query.staffId) : null;
    const resourceId =
      req.query.resourceId !== undefined ? Number(req.query.resourceId) : null;

    if (!tenantSlug) return res.status(400).json({ error: "tenantSlug is required" });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "serviceId is required" });
    }

    const tenantId = await getTenantIdFromSlug(tenantSlug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found" });

    // Load tenant timezone (if you later want true TZ math)
    const tenantRow = await db.query(
      `SELECT id, timezone FROM tenants WHERE id=$1 LIMIT 1`,
      [tenantId]
    );
    const tenantTimezone = tenantRow.rows?.[0]?.timezone || "UTC";

    // Load service (ONLY columns that exist in your schema)
    const svcRes = await db.query(
      `
      SELECT id, duration_minutes, requires_staff, requires_resource
      FROM services
      WHERE tenant_id=$1 AND id=$2 AND is_active = true
      LIMIT 1
      `,
      [tenantId, serviceId]
    );
    if (!svcRes.rows.length) {
      return res.status(404).json({ error: "Service not found" });
    }

    const service = svcRes.rows[0];
    const durationMinutes = Number(service.duration_minutes) || 60;
    const requiresStaff = !!service.requires_staff;
    const requiresResource = !!service.requires_resource;

    // If service requires staff/resource but it wasn't provided, there are no valid slots.
    if (requiresStaff && (!Number.isFinite(staffId) || staffId <= 0)) {
      return res.json({
        date,
        timeSlots: [],
        times: [],
        openTime: null,
        closeTime: null,
        stepMinutes: STEP_MIN,
        durationMinutes,
        timezone: tenantTimezone,
      });
    }
    if (requiresResource && (!Number.isFinite(resourceId) || resourceId <= 0)) {
      return res.json({
        date,
        timeSlots: [],
        times: [],
        openTime: null,
        closeTime: null,
        stepMinutes: STEP_MIN,
        durationMinutes,
        timezone: tenantTimezone,
      });
    }

    // Determine day_of_week from date using Postgres (stable & simple)
    const dowRes = await db.query(
      `SELECT EXTRACT(DOW FROM $1::date)::int AS dow`,
      [date]
    );
    const dayOfWeek = dowRes.rows[0].dow; // 0=Sunday

    // Load tenant hours for that day
    const hoursRes = await db.query(
      `
      SELECT open_time, close_time, is_closed
      FROM tenant_hours
      WHERE tenant_id=$1 AND day_of_week=$2
      LIMIT 1
      `,
      [tenantId, dayOfWeek]
    );

    if (!hoursRes.rows.length || hoursRes.rows[0].is_closed) {
      return res.json({
        date,
        timeSlots: [],
        times: [],
        openTime: null,
        closeTime: null,
        stepMinutes: STEP_MIN,
        durationMinutes,
        timezone: tenantTimezone,
      });
    }

    const openTime = hoursRes.rows[0].open_time;   // "10:00:00"
    const closeTime = hoursRes.rows[0].close_time; // "00:00:00" possible

    // Build open/close boundaries
    let openDt = toUtcDateTime(date, openTime);
    let closeDt = toUtcDateTime(date, closeTime);

    // Midnight close / overnight handling:
    // if close <= open, treat close as next day
    if (closeDt.getTime() <= openDt.getTime()) {
      closeDt = addMinutes(closeDt, 24 * 60);
    }

    // Generate all potential slot starts on a fixed STEP_MIN grid
    const allSlots = [];
    for (
      let t = new Date(openDt);
      addMinutes(t, durationMinutes).getTime() <= closeDt.getTime();
      t = addMinutes(t, STEP_MIN)
    ) {
      allSlots.push(new Date(t));
    }

    if (!allSlots.length) {
      return res.json({
        date,
        timeSlots: [],
        times: [],
        openTime,
        closeTime,
        stepMinutes: STEP_MIN,
        durationMinutes,
        timezone: tenantTimezone,
      });
    }

    // Fetch bookings overlapping the operating window (single query)
    // Only consider non-cancelled bookings
    const params = [tenantId, openDt.toISOString(), closeDt.toISOString()];
    let where = `
      b.tenant_id = $1
      AND b.status != 'cancelled'
      AND b.start_time < $3::timestamptz
      AND (b.start_time + (b.duration_minutes || ' minutes')::interval) > $2::timestamptz
    `;

    if (requiresResource) {
      params.push(resourceId);
      where += ` AND b.resource_id = $${params.length}`;
    }
    if (requiresStaff) {
      params.push(staffId);
      where += ` AND b.staff_id = $${params.length}`;
    }

    const bookingsRes = await db.query(
      `
      SELECT b.start_time, b.duration_minutes
      FROM bookings b
      WHERE ${where}
      `,
      params
    );

    const bookings = bookingsRes.rows.map((r) => {
      const bs = new Date(r.start_time);
      const be = addMinutes(bs, Number(r.duration_minutes) || durationMinutes);
      return { start: bs, end: be };
    });

    // max_parallel is NOT in your schema, so enforce 1 for now.
    // (If you want parallel slots later, add a real column + migration.)
    const maxParallel = 1;

    const available = [];
    for (const slotStart of allSlots) {
      const slotEnd = addMinutes(slotStart, durationMinutes);

      let overlaps = 0;
      for (const b of bookings) {
        if (slotStart < b.end && slotEnd > b.start) overlaps++;
        if (overlaps >= maxParallel) break;
      }

      if (overlaps < maxParallel) {
        available.push(fmtHHMM(slotStart));
      }
    }

    return res.json({
      date,
      timeSlots: available, // ✅ what your frontend expects
      times: available,     // ✅ compatibility if anything else uses "times"
      openTime,
      closeTime,
      stepMinutes: STEP_MIN,
      durationMinutes,
      timezone: tenantTimezone,
    });
  } catch (err) {
    console.error("GET /api/availability error:", err);
    return res.status(500).json({ error: "Failed to load availability." });
  }
});

module.exports = router;
