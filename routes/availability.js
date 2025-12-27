// routes/availability.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
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
  // "HH:MM" -> minutes
  const [h, m] = String(t).split(":").map((x) => Number(x));
  return h * 60 + m;
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

// GET /api/availability?tenantSlug=&tenantId=&date=YYYY-MM-DD&serviceId=&staffId=&resourceId=
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, date, serviceId, staffId, resourceId } = req.query;

    if (!date) return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    if (!serviceId) return res.status(400).json({ error: "serviceId is required" });

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }
    if (!resolvedTenantId) return res.status(400).json({ error: "Unknown tenant." });

    const svcRes = await db.query(
      `SELECT id, duration_minutes, requires_staff, requires_resource FROM services WHERE id = $1`,
      [Number(serviceId)]
    );
    if (!svcRes.rows.length) return res.status(400).json({ error: "Unknown serviceId." });

    const svc = svcRes.rows[0];
    const duration = Number(svc.duration_minutes || 60);

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    if (svc.requires_staff && !staff_id) {
      return res.json({ slots: [] });
    }
    if (svc.requires_resource && !resource_id) {
      return res.json({ slots: [] });
    }

    // Determine day_of_week from provided date (0=Sunday..6=Saturday)
    const d = new Date(`${date}T00:00:00`);
    const dayOfWeek = d.getDay();

    // tenant hours
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

    const openTime = hoursRes.rows[0].open_time;   // "08:00:00"
    const closeTime = hoursRes.rows[0].close_time; // "22:00:00"

    const openHHMM = String(openTime).slice(0, 5);
    const closeHHMM = String(closeTime).slice(0, 5);

    const openMin = timeToMinutes(openHHMM);
    const closeMin = timeToMinutes(closeHHMM);

    // Load bookings for that day (simple day filter; matches your current style)
    const params = [resolvedTenantId, date];
    let where = `
      b.tenant_id = $1
      AND b.start_time::date = $2::date
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

    // Convert bookings into minutes-from-midnight for overlap test
    const busy = bookingsRes.rows.map((b) => {
      const start = new Date(b.start_time);
      const startMin = start.getHours() * 60 + start.getMinutes();
      const endMin = startMin + Number(b.duration_minutes || 0);
      return { startMin, endMin };
    });

    const step = 15; // 15-minute grid
    const slots = [];

    for (let t = openMin; t + duration <= closeMin; t += step) {
      const candidateStart = t;
      const candidateEnd = t + duration;

      const isBlocked = busy.some((x) => overlaps(candidateStart, candidateEnd, x.startMin, x.endMin));
      if (!isBlocked) slots.push(toHHMM(candidateStart));
    }

    return res.json({ slots });
  } catch (err) {
    console.error("Error calculating availability:", err);
    return res.status(500).json({ error: "Failed to calculate availability" });
  }
});

module.exports = router;
