// routes/availability.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { getTenantIdFromSlug } = require("../utils/tenants");

// ---------- constants ----------
const STEP_MIN = 15;

// ---------- helpers ----------
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function minutesToHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function yyyyMmDdFromUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function addDaysUTC(base, days) {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Day-of-week in tenant timezone (0..6 Sun..Sat)
function dayOfWeekInTZ(dateStr, timeZone) {
  // Use noon UTC to avoid DST boundary issues
  const d = new Date(`${dateStr}T12:00:00Z`);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

// Create "YYYY-MM-DD HH:MM:SS" from a base date and minutes offset (can exceed 1440)
function dateTimeStringFromCursor(baseDateUTC, cursorMin) {
  const dayOffset = Math.floor(cursorMin / (24 * 60));
  const minsInDay = cursorMin % (24 * 60);
  const hhmm = minutesToHHMM(minsInDay);
  const d = addDaysUTC(baseDateUTC, dayOffset);
  return `${yyyyMmDdFromUTC(d)} ${hhmm}:00`;
}

/**
 * GET /api/availability
 *
 * Query params:
 *  - tenantSlug OR tenantId
 *  - serviceId (required)
 *  - date=YYYY-MM-DD (required)
 *  - staffId (optional)
 *  - resourceId (optional)
 *
 * Response:
 *  - slots: ALL pills with available=true/false
 *  - times: available-only times (legacy)
 */
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, serviceId, date, staffId, resourceId } = req.query;

    if (!serviceId || !date) {
      return res.status(400).json({ error: "serviceId and date are required." });
    }

    // Resolve tenantId
    let tid = tenantId ? Number(tenantId) : null;
    if (!tid && tenantSlug) {
      tid = await getTenantIdFromSlug(String(tenantSlug));
    }
    if (!tid) {
      return res.status(400).json({ error: "tenantSlug or tenantId is required." });
    }

    const sid = Number(serviceId);
    const staff = staffId ? Number(staffId) : null;
    const resource = resourceId ? Number(resourceId) : null;

    // Tenant timezone (fallback to Asia/Amman)
    const tzRes = await pool.query(`SELECT timezone FROM tenants WHERE id = $1`, [tid]);
    const timeZone = tzRes.rows?.[0]?.timezone || "Asia/Amman";

    // Load service rules
    const svcRes = await pool.query(
      `
      SELECT id,
             duration_minutes,
             requires_staff,
             requires_resource,
             COALESCE(max_parallel, 1) AS max_parallel
      FROM services
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
      `,
      [tid, sid]
    );

    if (svcRes.rows.length === 0) {
      return res.status(404).json({ error: "Service not found for tenant." });
    }

    const durationMin = Number(svcRes.rows[0].duration_minutes || 0);
    const reqStaff = Boolean(svcRes.rows[0].requires_staff);
    const reqResource = Boolean(svcRes.rows[0].requires_resource);
    const maxParallel = Number(svcRes.rows[0].max_parallel || 1);

    if (!durationMin || durationMin < 1) {
      return res.status(400).json({ error: "Service has invalid duration_minutes." });
    }

    // If service requires staff/resource but UI hasn't selected it yet, return empty (expected)
    if (reqStaff && !staff) {
      return res.json({
        tenantId: tid,
        tenantSlug: tenantSlug ?? null,
        date,
        times: [],
        slots: [],
        meta: { reason: "missing_staff" },
      });
    }
    if (reqResource && !resource) {
      return res.json({
        tenantId: tid,
        tenantSlug: tenantSlug ?? null,
        date,
        times: [],
        slots: [],
        meta: { reason: "missing_resource" },
      });
    }

    // Working hours for that day (day_of_week computed in tenant TZ)
    const dow = dayOfWeekInTZ(String(date), timeZone);

    const hoursRes = await pool.query(
      `
      SELECT open_time, close_time, is_closed
      FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1
      `,
      [tid, dow]
    );

    if (hoursRes.rows.length === 0) {
      return res.json({
        tenantId: tid,
        tenantSlug: tenantSlug ?? null,
        date,
        times: [],
        slots: [],
        meta: { reason: "no_hours_row", day_of_week: dow, tz: timeZone },
      });
    }

    const hours = hoursRes.rows[0];
    if (hours.is_closed) {
      return res.json({
        tenantId: tid,
        tenantSlug: tenantSlug ?? null,
        date,
        times: [],
        slots: [],
        meta: { reason: "closed_day", day_of_week: dow, tz: timeZone },
      });
    }

    const openHHMM = String(hours.open_time).slice(0, 5);
    const closeHHMM = String(hours.close_time).slice(0, 5);

    const baseDateUTC = new Date(`${date}T00:00:00Z`);

    const openMin = toMinutes(openHHMM);
    let closeMin = toMinutes(closeHHMM);

    // ✅ Overnight handling (midnight close): close <= open means next day
    if (closeMin <= openMin) closeMin += 24 * 60;

    // Booking window in "YYYY-MM-DD HH:MM:SS" strings (supports crossing midnight)
    const windowStart = dateTimeStringFromCursor(baseDateUTC, openMin);
    const windowEnd = dateTimeStringFromCursor(baseDateUTC, closeMin);

    // -------------------------
    // Fetch ALL bookings in the window with ONE query
    // and compute offset minutes in SQL (no JS Date parsing)
    // -------------------------
    const params = [tid, windowEnd, windowStart, windowStart];
    let extra = "";

    if (reqStaff) {
      params.push(staff);
      extra += ` AND b.staff_id = $${params.length}`;
    }
    if (reqResource) {
      params.push(resource);
      extra += ` AND b.resource_id = $${params.length}`;
    }

    const bookingsRes = await pool.query(
      `
      SELECT
        b.start_time,
        b.duration_minutes,
        GREATEST(
          0,
          FLOOR(EXTRACT(EPOCH FROM (b.start_time - $4::timestamp)) / 60)::int
        ) AS start_off_min,
        LEAST(
          FLOOR(EXTRACT(EPOCH FROM (($4::timestamp + ((($2::timestamp - $4::timestamp)))) - $4::timestamp)) / 60)::int,
          FLOOR(EXTRACT(EPOCH FROM ((b.start_time + (b.duration_minutes || ' minutes')::interval) - $4::timestamp)) / 60)::int
        ) AS end_off_min
      FROM bookings b
      WHERE b.tenant_id = $1
        AND b.start_time < $2::timestamp
        AND (b.start_time + (b.duration_minutes || ' minutes')::interval) > $3::timestamp
        AND COALESCE(b.status,'') NOT IN ('cancelled','canceled')
        ${extra}
      `,
      params
    );

    // Window length in minutes
    const windowLen = closeMin - openMin;

    // Build busy counts per minute using a diff array (O(bookings + windowLen))
    const diff = new Array(windowLen + 2).fill(0);

    for (const b of bookingsRes.rows) {
      const s = Math.max(0, Math.min(windowLen, Number(b.start_off_min)));
      const e = Math.max(0, Math.min(windowLen, Number(b.end_off_min)));

      if (e > s) {
        diff[s] += 1;
        diff[e] -= 1;
      }
    }

    const busy = new Array(windowLen + 1).fill(0);
    let cur = 0;
    for (let i = 0; i <= windowLen; i++) {
      cur += diff[i];
      busy[i] = cur;
    }

    // Helper: determine overlap peak inside a slot interval
    function maxBusyInRange(startMinAbs, endMinAbsExclusive) {
      // Convert absolute minutes to window-relative indices
      const startIdx = Math.max(0, startMinAbs - openMin);
      const endIdx = Math.min(windowLen, endMinAbsExclusive - openMin);
      let peak = 0;
      for (let i = startIdx; i < endIdx; i++) {
        if (busy[i] > peak) peak = busy[i];
        if (peak >= maxParallel) break;
      }
      return peak;
    }

    // -------------------------
    // Generate ALL pills (available or not)
    // -------------------------
    const slots = [];
    const times = [];

    for (let cursor = openMin; cursor + durationMin <= closeMin; cursor += STEP_MIN) {
      const slotStartAbs = cursor;
      const slotEndAbs = cursor + durationMin;

      const peak = maxBusyInRange(slotStartAbs, slotEndAbs);
      const isAvailable = peak < maxParallel;

      const label = minutesToHHMM(slotStartAbs % (24 * 60));

      const slotObj = {
        time: label,
        label,
        available: isAvailable,
        is_available: isAvailable,
        overlaps: peak,
        capacity: maxParallel,
      };

      slots.push(slotObj);
      if (isAvailable) times.push(label);
    }

    return res.json({
      tenantId: tid,
      tenantSlug: tenantSlug ?? null,
      date,
      times,
      slots,
      meta: {
        tz: timeZone,
        day_of_week: dow,
        open: openHHMM,
        close: closeHHMM,
        windowStart,
        windowEnd,
        durationMin,
        stepMin: STEP_MIN,
        maxParallel,
        bookingsInWindow: bookingsRes.rows.length,
        slotCount: slots.length,
      },
    });
  } catch (err) {
    console.error("GET /api/availability error:", err);
    return res.status(500).json({ error: "Failed to load availability." });
  }
});

module.exports = router;
