// routes/availability.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool; // ✅ keeps db.query(...) working
const { getTenantIdFromSlug } = require("../utils/tenants");

// Helpers
function pad(n) {
  return String(n).padStart(2, "0");
}
function toHHMM(totalMinutes) {
  // totalMinutes may be > 1440 (wrap case). Convert to display HH:MM in 0..23 range.
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${pad(h)}:${pad(mm)}`;
}
function timeToMinutes(t) {
  // "HH:MM" -> minutes
  const [h, m] = String(t).split(":").map((x) => Number(x));
  return h * 60 + m;
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
function isoDatePlusDays(yyyyMmDd, days) {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// GET /api/availability?tenantSlug=&tenantId=&date=YYYY-MM-DD&serviceId=&staffId=&resourceId=
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, date, serviceId, staffId, resourceId } =
      req.query;

    if (!date)
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    if (!serviceId)
      return res.status(400).json({ error: "serviceId is required" });

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }
    if (!resolvedTenantId)
      return res.status(400).json({ error: "Unknown tenant." });

    // ---- Service config --------------------------------------------------------
    const svcRes = await db.query(
      `
      SELECT
        id,
        duration_minutes,
        requires_staff,
        requires_resource,
        slot_interval_minutes,
        max_parallel_bookings
      FROM services
      WHERE id = $1
      `,
      [Number(serviceId)]
    );

    if (!svcRes.rows.length) {
      return res.status(400).json({ error: "Unknown serviceId." });
    }

    const svc = svcRes.rows[0];

    // duration + slot step + capacity (with safe fallbacks)
    const duration = Number(svc.duration_minutes || 60);
    const step = Number(svc.slot_interval_minutes || duration);
    const maxParallel = Number(svc.max_parallel_bookings || 1);

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    // If required but missing, return empty slots
    if (svc.requires_staff && !staff_id) return res.json({ slots: [] });
    if (svc.requires_resource && !resource_id) return res.json({ slots: [] });

    // Determine day_of_week from provided date (0=Sunday..6=Saturday)
    const d = new Date(`${date}T00:00:00`);
    const dayOfWeek = d.getDay();

    // ---- Tenant hours ----------------------------------------------------------
    const hoursRes = await db.query(
      `
      SELECT open_time, close_time, is_closed
      FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1
      `,
      [resolvedTenantId, dayOfWeek]
    );

    if (!hoursRes.rows.length || hoursRes.rows[0].is_closed) {
      return res.json({ slots: [] });
    }

    const openTime = hoursRes.rows[0].open_time; // "08:00:00"
    const closeTime = hoursRes.rows[0].close_time; // "22:00:00" or "00:00:00"

    const openHHMM = String(openTime).slice(0, 5);
    const closeHHMM = String(closeTime).slice(0, 5);

    let openMin = timeToMinutes(openHHMM);
    let closeMin = timeToMinutes(closeHHMM);

    // ✅ Legacy wrap: if close <= open, it means "wrap to next day"
    const wrapsPastMidnight = closeMin <= openMin;
    if (wrapsPastMidnight) {
      closeMin += 24 * 60; // 1440
    }

    // ---- Load bookings (THIS WAS MISSING) -------------------------------------
    // We query from date 00:00 to date end; if wrap, include the next day too.
    const dateStartISO = `${date}T00:00:00.000Z`;
    const endDate = wrapsPastMidnight ? isoDatePlusDays(date, 1) : date;
    const dateEndISO = `${endDate}T23:59:59.999Z`;

    const params = [];
    const where = [];

    params.push(resolvedTenantId);
    where.push(`b.tenant_id = $${params.length}`);

    params.push(Number(serviceId));
    where.push(`b.service_id = $${params.length}`);

    if (staff_id) {
      params.push(staff_id);
      where.push(`b.staff_id = $${params.length}`);
    }
    if (resource_id) {
      params.push(resource_id);
      where.push(`b.resource_id = $${params.length}`);
    }

    // ignore cancelled
    where.push(`(b.status IS NULL OR b.status <> 'cancelled')`);

    params.push(dateStartISO);
    const startIdx = params.length;

    params.push(dateEndISO);
    const endIdx = params.length;

    // duration fallback param
    params.push(duration);
    const durIdx = params.length;

    const bookingsRes = await db.query(
      `
      SELECT
        b.start_time,
        COALESCE(b.duration_minutes, $${durIdx}) AS duration_minutes
      FROM bookings b
      WHERE ${where.join(" AND ")}
        AND b.start_time >= $${startIdx}
        AND b.start_time <= $${endIdx}
      ORDER BY b.start_time ASC
      `,
      params
    );

    // Convert bookings into minutes-from-selected-date-midnight for overlap test
    // (so bookings on the next day become > 1440 minutes — correct for wrap logic)
    const baseMs = new Date(`${date}T00:00:00.000Z`).getTime();

    const busy = bookingsRes.rows.map((b) => {
      const startMs = new Date(b.start_time).getTime();
      const startMin = Math.round((startMs - baseMs) / 60000); // can be > 1440
      const endMin = startMin + Number(b.duration_minutes || 0);
      return { startMin, endMin };
    });

    // ---- Generate slots (capacity-aware) --------------------------------------
    const slots = [];

    // Safety: ensure step is valid
    const stepMin = Number.isFinite(step) && step > 0 ? step : duration;

    for (let t = openMin; t + duration <= closeMin; t += stepMin) {
      const candidateStart = t;
      const candidateEnd = t + duration;

      // Count overlaps (capacity)
      const overlapsCount = busy.reduce((acc, x) => {
        return acc + (overlaps(candidateStart, candidateEnd, x.startMin, x.endMin) ? 1 : 0);
      }, 0);

      if (overlapsCount < maxParallel) {
        slots.push(toHHMM(candidateStart));
      }
    }

    return res.json({ slots });
  } catch (err) {
    console.error("Error calculating availability:", err);
    return res.status(500).json({ error: "Failed to calculate availability" });
  }
});

module.exports = router;
