// routes/availability.js
// Returns ALL candidate slots for a day, each with is_available/available flags.
// Keeps `times` (available-only) for backward compatibility.
//
// ✅ Works for BOTH public booking (tenantSlug) and owner/manual booking (tenantId).

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

// Accept YYYY-MM-DD (preferred). If a locale date slips through (MM/DD/YYYY),
// normalize it to YYYY-MM-DD so day-of-week + DB queries work reliably.
function normalizeDateInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  // Already ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Common US locale: MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const mm = pad2(Number(mdy[1]));
    const dd = pad2(Number(mdy[2]));
    const yyyy = mdy[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  // Last resort: try Date parse and format
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  return s; // let downstream handle/return empty
}

const DEFAULT_OPEN = "08:00";
const DEFAULT_CLOSE = "22:00";

router.get("/", async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId: tenantIdRaw,
      date: dateRaw,
      serviceId: serviceIdRaw,
      staffId: staffIdRaw,
      resourceId: resourceIdRaw,
    } = req.query;

    const date = normalizeDateInput(dateRaw);

    if ((!tenantSlug && !tenantIdRaw) || !date || !serviceIdRaw) {
      return res.status(400).json({
        error: "Missing required params: (tenantSlug OR tenantId), date, serviceId",
      });
    }

    // Normalize ids
    const serviceId = Number(serviceIdRaw);
    const staffId = staffIdRaw != null && staffIdRaw !== "" ? Number(staffIdRaw) : null;
    const resourceId =
      resourceIdRaw != null && resourceIdRaw !== "" ? Number(resourceIdRaw) : null;

    // 1) Resolve tenantId (supports either tenantId or tenantSlug)
    let tenantId = tenantIdRaw != null && tenantIdRaw !== "" ? Number(tenantIdRaw) : null;

    if (!tenantId) {
      const tenantResult = await pool.query(
        "SELECT id, slug FROM tenants WHERE slug = $1",
        [tenantSlug]
      );
      if (tenantResult.rows.length === 0) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      tenantId = Number(tenantResult.rows[0].id);
    }

    if (!Number.isFinite(tenantId) || !Number.isFinite(serviceId)) {
      return res.status(400).json({ error: "Invalid tenantId/serviceId" });
    }

    // 2) Get service details
    const serviceResult = await pool.query(
      `SELECT * FROM services WHERE id = $1 AND tenant_id = $2`,
      [serviceId, tenantId]
    );
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ error: "Service not found" });
    }

    const service = serviceResult.rows[0];

    // Support both schema variants: services.minutes or services.duration_minutes
    const serviceMinutes = Number((service && (service.minutes ?? service.duration_minutes ?? service.duration)) ?? 0) || 0;
    const slotInterval = Number((service && (service.slot_interval_minutes ?? service.slotIntervalMinutes)) ?? serviceMinutes) || serviceMinutes || 60;

    const durationMin = serviceMinutes || 60;
    const stepMin = slotInterval || durationMin;
    const maxParallel = Number(service.max_parallel_bookings) || 1;

    const reqStaff = !!service.requires_staff;
    const reqResource = !!service.requires_resource;

    // If the service requires staff/resource but none selected yet, return "no slots" (same UX as public flow)
    if (reqStaff && !staffId) {
      return res.json({
        tenantId,
        tenantSlug: tenantSlug ?? null,
        date,
        times: [],
        slots: [],
        meta: {
          duration_minutes: durationMin,
          slot_interval_minutes: stepMin,
          max_parallel_bookings: maxParallel,
          requires_staff: reqStaff,
          requires_resource: reqResource,
          reason: "staff_required",
        },
      });
    }
    if (reqResource && !resourceId) {
      return res.json({
        tenantId,
        tenantSlug: tenantSlug ?? null,
        date,
        times: [],
        slots: [],
        meta: {
          duration_minutes: durationMin,
          slot_interval_minutes: stepMin,
          max_parallel_bookings: maxParallel,
          requires_staff: reqStaff,
          requires_resource: reqResource,
          reason: "resource_required",
        },
      });
    }

    // 3) Tenant working hours for day of week
    // Force UTC-safe parsing of YYYY-MM-DD
    const dowDate = new Date(`${date}T00:00:00Z`);
    const dayOfWeek = dowDate.getUTCDay();
    if (!Number.isFinite(dayOfWeek)) {
      return res.status(400).json({
        error: "Invalid date format. Use YYYY-MM-DD.",
        meta: { dateReceived: String(dateRaw || "") },
      });
    }

    const hoursResult = await pool.query(
      `
      SELECT open_time, close_time, is_closed
      FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1
      `,
      [tenantId, dayOfWeek]
    );

    // If no tenant_hours row exists yet, use safe defaults so the UI can still function.
    // This prevents "no slots" for new tenants before Setup is completed.
    let usedDefaultHours = false;

    if (hoursResult.rows.length === 0) {
      usedDefaultHours = true;
    } else if (hoursResult.rows[0].is_closed) {
      return res.json({
        tenantId,
        tenantSlug: tenantSlug ?? null,
        date,
        times: [],
        slots: [],
        meta: {
          duration_minutes: durationMin,
          slot_interval_minutes: stepMin,
          max_parallel_bookings: maxParallel,
          requires_staff: reqStaff,
          requires_resource: reqResource,
          reason: "tenant_closed",
        },
      });
    }

    const openTime = hoursResult.rows.length ? hoursResult.rows[0].open_time : null; // "HH:MM:SS" or "HH:MM"
    const closeTime = hoursResult.rows.length ? hoursResult.rows[0].close_time : null;

    const openHHMM = String(openTime || DEFAULT_OPEN).slice(0, 5);
    const closeHHMM = String(closeTime || DEFAULT_CLOSE).slice(0, 5);

    // Guard against bad data (null times but is_closed=false)
    if (!/^\d{2}:\d{2}$/.test(openHHMM) || !/^\d{2}:\d{2}$/.test(closeHHMM)) {
      return res.json({
        tenantId,
        tenantSlug: tenantSlug ?? null,
        date,
        times: [],
        slots: [],
        meta: {
          duration_minutes: durationMin,
          slot_interval_minutes: stepMin,
          max_parallel_bookings: maxParallel,
          requires_staff: reqStaff,
          requires_resource: reqResource,
          reason: "invalid_working_hours",
          open_time: openTime,
          close_time: closeTime,
        },
      });
    }

    // 4) Build all candidate slots
    const allSlots = [];
    const availableTimes = [];

    let cursor = toMinutes(openHHMM);
    const closeMin = toMinutes(closeHHMM);

    while (cursor + durationMin <= closeMin) {
      const startHHMM = minutesToHHMM(cursor);
      const endHHMM = minutesToHHMM(cursor + durationMin);

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

      // Overlap: existing.start < candidateEnd AND existing.end > candidateStart
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
        // helpful for UI + debugging
        overlaps: overlapsCount,
        capacity: maxParallel,
      };

      allSlots.push(slotObj);
      if (isAvailable) availableTimes.push(startHHMM);

      cursor += stepMin;
    }

    return res.json({
      tenantId,
      tenantSlug: tenantSlug ?? null,
      date,
      times: availableTimes, // backward compatible (available-only)
      slots: allSlots, // preferred (includes unavailable)
      meta: {
        duration_minutes: durationMin,
        slot_interval_minutes: stepMin,
        max_parallel_bookings: maxParallel,
        requires_staff: reqStaff,
        requires_resource: reqResource,
        staffId: staffId ?? null,
        resourceId: resourceId ?? null,
        used_default_hours: usedDefaultHours,
        day_of_week: dayOfWeek,
      },
    });
  } catch (err) {
    console.error("GET /api/availability error:", err);
    // Include message for debugging (remove later if you want)
    return res.status(500).json({
      error: "Failed to get availability",
      message: err?.message ?? String(err),
    });
  }
});

module.exports = router;
