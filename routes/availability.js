// routes/availability.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { requireTenant } = require("../middleware/requireTenant");

// Helpers
function pad(n) { return String(n).padStart(2, "0"); }
function toHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad(h)}:${pad(m)}`;
}
function timeToMinutes(t) {
  const [h, m] = String(t).split(":").map((x) => Number(x));
  return h * 60 + m;
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
function labelFromHHMM(hhmm) {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// GET /api/availability?tenantSlug|tenantId&date&serviceId&staffId?&resourceId?
router.get("/", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { date, serviceId, staffId, resourceId } = req.query;

    if (!date) return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    if (!serviceId) return res.status(400).json({ error: "serviceId is required" });

    // ✅ Service must belong to tenant (P1)
    const svcRes = await db.query(
      `
      SELECT
        id,
        tenant_id,
        duration_minutes,
        requires_staff,
        requires_resource,
        slot_interval_minutes,
        max_parallel_bookings
      FROM services
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1
      `,
      [Number(serviceId), tenantId]
    );

    if (!svcRes.rows.length) {
      return res.status(400).json({ error: "Unknown serviceId for this tenant." });
    }

    const svc = svcRes.rows[0];
    const duration = Number(svc.duration_minutes || 60);
    const stepMin = Number(svc.slot_interval_minutes || duration) || duration;
    const maxParallel = Number(svc.max_parallel_bookings || 1);

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    // ✅ If required, must be present
    if (svc.requires_staff && !staff_id) return res.json({ slots: [], times: [] });
    if (svc.requires_resource && !resource_id) return res.json({ slots: [], times: [] });

    // ✅ Validate staff/resource belong to tenant if provided (P1)
    if (staff_id) {
      const st = await db.query(`SELECT id FROM staff WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [staff_id, tenantId]);
      if (!st.rows.length) return res.status(400).json({ error: "staffId not valid for tenant." });
    }
    if (resource_id) {
      const rr = await db.query(`SELECT id FROM resources WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [resource_id, tenantId]);
      if (!rr.rows.length) return res.status(400).json({ error: "resourceId not valid for tenant." });
    }

    const baseLocal = new Date(`${date}T00:00:00`);
    const dayOfWeek = baseLocal.getDay();

    // Tenant hours
    const hoursRes = await db.query(
      `
      SELECT open_time, close_time, is_closed
      FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1
      `,
      [tenantId, dayOfWeek]
    );

    if (!hoursRes.rows.length || hoursRes.rows[0].is_closed) {
      return res.json({ slots: [], times: [] });
    }

    const openHHMM = String(hoursRes.rows[0].open_time).slice(0, 5);
    const closeHHMM = String(hoursRes.rows[0].close_time).slice(0, 5);

    let openMin = timeToMinutes(openHHMM);
    let closeMin = timeToMinutes(closeHHMM);
    if (closeMin <= openMin) closeMin += 24 * 60;

    const extraWrapMinutes = closeMin > 24 * 60 ? closeMin - 24 * 60 : 0;
    const rangeStart = new Date(`${date}T00:00:00`);
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setDate(rangeEnd.getDate() + 1);
    if (extraWrapMinutes > 0) rangeEnd.setMinutes(rangeEnd.getMinutes() + extraWrapMinutes);

    const params = [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()];
    let where = `
      b.tenant_id = $1
      AND b.start_time >= $2::timestamptz
      AND b.start_time <  $3::timestamptz
      AND b.status = ANY(ARRAY['pending','confirmed'])
    `;

    if (staff_id) { params.push(staff_id); where += ` AND b.staff_id = $${params.length}`; }
    if (resource_id) { params.push(resource_id); where += ` AND b.resource_id = $${params.length}`; }

    const bookingsRes = await db.query(
      `
      SELECT start_time, duration_minutes
      FROM bookings b
      WHERE ${where}
      ORDER BY start_time ASC
      `,
      params
    );

    const busy = bookingsRes.rows.map((b) => {
      const start = new Date(b.start_time);
      const startMin = Math.round((start.getTime() - baseLocal.getTime()) / 60000);
      const endMin = startMin + Number(b.duration_minutes || 0);
      return { startMin, endMin };
    });

    const times = [];
    for (let t = openMin; t + duration <= closeMin; t += stepMin) {
      const candidateStart = t;
      const candidateEnd = t + duration;

      const overlapsCount = busy.reduce((acc, x) => {
        return acc + (overlaps(candidateStart, candidateEnd, x.startMin, x.endMin) ? 1 : 0);
      }, 0);

      if (overlapsCount < maxParallel) {
        times.push(toHHMM(candidateStart % (24 * 60)));
      }
    }

    const slots = times.map((time) => ({
      time,
      label: labelFromHHMM(time),
      available: true,
    }));

    return res.json({
      slots,
      times,
      durationMinutes: duration,
      slotIntervalMinutes: stepMin,
    });
  } catch (err) {
    console.error("Error calculating availability:", err);
    return res.status(500).json({ error: "Failed to calculate availability" });
  }
});

module.exports = router;
