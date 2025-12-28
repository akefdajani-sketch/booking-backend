// routes/availability.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool; // keeps db.query(...) working
const { getTenantIdFromSlug } = require("../utils/tenants");

// Helpers
function pad(n) {
  return String(n).padStart(2, "0");
}
function toHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad(h)}:${pad(m)}`;
}
function timeToMinutes(t) {
  // "HH:MM" or "HH:MM:SS" -> minutes
  const [h, m] = String(t).split(":").map((x) => Number(x));
  return h * 60 + m;
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, date, serviceId, staffId, resourceId } =
      req.query;

    if (!date)
      return res
        .status(400)
        .json({ error: "date is required (YYYY-MM-DD)" });
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

    const duration = Number(svc.duration_minutes || 60);
    const step = Number(svc.slot_interval_minutes || duration);
    const maxParallel = Number(svc.max_parallel_bookings || 1);

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    if (svc.requires_staff && !staff_id) return res.json({ slots: [], times: [] });
    if (svc.requires_resource && !resource_id) return res.json({ slots: [], times: [] });

    // Determine day_of_week from provided date (0=Sunday..6=Saturday)
    const baseLocal = new Date(`${date}T00:00:00`);
    const dayOfWeek = baseLocal.getDay();

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
      return res.json({ slots: [], times: [] });
    }

    const openTime = hoursRes.rows[0].open_time;   // "10:00:00"
    const closeTime = hoursRes.rows[0].close_time; // "00:00:00" or "22:00:00"

    const openHHMM = String(openTime).slice(0, 5);
    const closeHHMM = String(closeTime).slice(0, 5);

    let openMin = timeToMinutes(openHHMM);
    let closeMin = timeToMinutes(closeHHMM);

    // If close <= open, treat as "wrap to next day" (10:00 -> 00:00)
    if (closeMin <= openMin) {
      closeMin += 24 * 60; // 1440
    }

    // ---- Bookings window (include next-day early bookings if wrap) -------------
    // We'll query from base date 00:00 up to base + 1 day + extra wrap minutes
    const extraWrapMinutes = closeMin > 24 * 60 ? closeMin - 24 * 60 : 0;

    const rangeStart = new Date(`${date}T00:00:00`);
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setDate(rangeEnd.getDate() + 1);
    if (extraWrapMinutes > 0) {
      rangeEnd.setMinutes(rangeEnd.getMinutes() + extraWrapMinutes);
    }

    const params = [resolvedTenantId, rangeStart.toISOString(), rangeEnd.toISOString()];
    let where = `
      b.tenant_id = $1
      AND b.start_time >= $2::timestamptz
      AND b.start_time <  $3::timestamptz
      AND b.status = ANY(ARRAY['pending','confirmed'])
    `;

    if (staff_id) {
      params.push(staff_id);
      where += ` AND b.staff_id = $${params.length}`;
    }
    if (resource_id) {
      params.push(resource_id);
      where += ` AND b.resource_id = $${params.length}`;
    }

    const bookingsRes = await db.query(
      `
      SELECT start_time, duration_minutes
      FROM bookings b
      WHERE ${where}
      ORDER BY start_time ASC
      `,
      params
    );

    // Convert bookings into minutes-from-base for overlap test (wrap-safe)
    const busy = bookingsRes.rows.map((b) => {
      const start = new Date(b.start_time);
      const startMin = Math.round((start.getTime() - baseLocal.getTime()) / 60000);
      const endMin = startMin + Number(b.duration_minutes || 0);
      return { startMin, endMin };
    });

// ---- Generate slots (capacity-aware) --------------------------------------
const stepMin = Number.isFinite(step) && step > 0 ? step : duration;

// Optional: label formatter (safe + simple)
function labelFromHHMM(hhmm) {
  // If you don’t care about AM/PM labels, you can just: return hhmm;
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

const times = [];

for (let t = openMin; t + duration <= closeMin; t += stepMin) {
  const candidateStart = t;
  const candidateEnd = t + duration;

  // Count overlaps (capacity-aware)
  const overlapsCount = busy.reduce((acc, x) => {
    return acc + (overlaps(candidateStart, candidateEnd, x.startMin, x.endMin) ? 1 : 0);
  }, 0);

  if (overlapsCount < maxParallel) {
    // Keep in-day HH:MM even if we wrapped past midnight
    times.push(toHHMM(candidateStart % (24 * 60)));
  }
}

// ✅ Return the legacy/expected shape (like old index.js)
const slots = times.map((time) => ({
  time,                 // frontend uses slot.time for selection
  label: labelFromHHMM(time), // optional, but matches old structure
  available: true,      // frontend commonly checks this to allow clicks
}));

return res.json({
  slots,                // ✅ objects
  times,                // ✅ strings (debug/back-compat)
  durationMinutes: duration,      // ✅ keep this (old route returned it)
  slotIntervalMinutes: stepMin,   // ✅ helpful for contiguous selection logic
});

  } catch (err) {
    console.error("Error calculating availability:", err);
    return res.status(500).json({ error: "Failed to calculate availability" });
  }
});

module.exports = router;
