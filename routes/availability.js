// routes/availability.js
// Returns ALL candidate slots for a day, each with is_available/available flags.
// Keeps `times` (available-only) for backward compatibility.

const express = require("express");
const router = express.Router();
const pool = require("../db");

// Helpers
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function minutesToHHMM(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${pad2(h)}:${pad2(m)}`;
}
function addMinutes(hhmm, mins) {
  return minutesToHHMM(toMinutes(hhmm) + mins);
}

router.get("/", async (req, res) => {
  try {
    const { tenantSlug, date, serviceId, staffId, resourceId } = req.query;

    if (!tenantSlug || !date || !serviceId) {
      return res.status(400).json({
        error: "Missing required params: tenantSlug, date, serviceId",
      });
    }

    // 1) Get tenant id
    const tenantResult = await pool.query(
      "SELECT id FROM tenants WHERE slug = $1",
      [tenantSlug]
    );
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    const tenantId = tenantResult.rows[0].id;

    // 2) Get service details (duration, requirements, slot settings)
    const serviceResult = await pool.query(
      `
      SELECT
        id,
        minutes,
        requires_staff,
        requires_resource,
        COALESCE(slot_interval_minutes, minutes) AS slot_interval_minutes,
        COALESCE(max_parallel_bookings, 1) AS max_parallel_bookings
      FROM services
      WHERE id = $1 AND tenant_id = $2
      `,
      [serviceId, tenantId]
    );
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ error: "Service not found" });
    }

    const service = serviceResult.rows[0];
    const durationMin = Number(service.minutes) || 60;
    const stepMin = Number(service.slot_interval_minutes) || durationMin;
    const maxParallel = Number(service.max_parallel_bookings) || 1;

    // Optional filters depending on requirements
    const reqStaff = !!service.requires_staff;
    const reqResource = !!service.requires_resource;

    // 3) Get tenant working hours for the day of week (0=Sunday..6=Saturday)
    const dayOfWeek = new Date(date).getUTCDay();
    const hoursResult = await pool.query(
      `
      SELECT open_time, close_time, is_closed
      FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1
      `,
      [tenantId, dayOfWeek]
    );

    if (hoursResult.rows.length === 0 || hoursResult.rows[0].is_closed) {
      return res.json({
        tenantSlug,
        date,
        times: [],
        slots: [],
      });
    }

    const openTime = hoursResult.rows[0].open_time;   // "HH:MM:SS" or "HH:MM"
    const closeTime = hoursResult.rows[0].close_time; // "HH:MM:SS" or "HH:MM"
    const openHHMM = String(openTime).slice(0, 5);
    const closeHHMM = String(closeTime).slice(0, 5);

    // 4) Fetch existing bookings that overlap the day (we'll check overlaps per candidate slot)
    const dayStart = `${date} 00:00:00`;
    const dayEnd = `${date} 23:59:59`;

    // Base query: bookings for tenant on that date range
    // We compute overlaps in SQL per candidate window by querying count for each window.
    // (This is OK for now. If you need higher scale, we can pre-fetch and compute in memory.)

    // 5) Build all candidate slots from open..close (exclusive of slots that would end after close)
    const allSlots = [];
    const availableTimes = [];

    let cursor = toMinutes(openHHMM);
    const closeMin = toMinutes(closeHHMM);

    while (cursor + durationMin <= closeMin) {
      const startHHMM = minutesToHHMM(cursor);
      const endHHMM = minutesToHHMM(cursor + durationMin);

      // Count overlapping bookings for this window
      // Overlap condition: existing.start < candidateEnd AND existing.end > candidateStart
      const candidateStart = `${date} ${startHHMM}:00`;
      const candidateEnd = `${date} ${endHHMM}:00`;

      const params = [tenantId, candidateEnd, candidateStart];
      let whereExtra = "";
      if (reqStaff && staffId) {
        params.push(staffId);
        whereExtra += ` AND staff_id = $${params.length}`;
      }
      if (reqResource && resourceId) {
        params.push(resourceId);
        whereExtra += ` AND resource_id = $${params.length}`;
      }

      const overlapResult = await pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM bookings
        WHERE tenant_id = $1
          AND start_time < $2
          AND (start_time + (duration_minutes || ' minutes')::interval) > $3
          AND status NOT IN ('cancelled')
          ${whereExtra}
        `,
        params
      );

      const overlapsCount = overlapResult.rows[0]?.count ?? 0;
      const isAvailable = overlapsCount < maxParallel;

      const slotObj = {
        time: startHHMM,
        label: startHHMM,
        is_available: isAvailable,
        available: isAvailable,
      };

      allSlots.push(slotObj);
      if (isAvailable) availableTimes.push(startHHMM);

      cursor += stepMin;
    }

    return res.json({
      tenantSlug,
      date,
      times: availableTimes, // backward-compatible
      slots: allSlots,       // preferred
      meta: {
        duration_minutes: durationMin,
        slot_interval_minutes: stepMin,
        max_parallel_bookings: maxParallel,
        requires_staff: reqStaff,
        requires_resource: reqResource,
      },
    });
  } catch (err) {
    console.error("GET /api/availability error:", err);
    return res.status(500).json({ error: "Failed to get availability" });
  }
});

module.exports = router;
