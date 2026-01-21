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

// Add days to an ISO date (YYYY-MM-DD) and return ISO date.
function addDaysISO(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
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
    // Tenant timezone (used to convert local candidate times into timestamptz ranges)
    let tenantTz = "UTC";

    if (!tenantId) {
      const tenantResult = await pool.query(
        "SELECT id, slug, timezone FROM tenants WHERE slug = $1",
        [tenantSlug]
      );
      if (tenantResult.rows.length === 0) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      tenantId = Number(tenantResult.rows[0].id);
      tenantTz = tenantResult.rows[0]?.timezone || "UTC";
    }

    // If tenantId was provided directly, fetch timezone
    if (tenantId && tenantTz === "UTC") {
      const tzResult = await pool.query("SELECT timezone FROM tenants WHERE id = $1", [tenantId]);
      tenantTz = tzResult.rows[0]?.timezone || "UTC";
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
    const reqResource = !!service.requires_resource

    const rawBasis = service.availability_basis ? String(service.availability_basis).toLowerCase() : "";
    const derivedBasis = reqStaff && reqResource ? "both" : reqStaff ? "staff" : reqResource ? "resource" : "none";
    // If DB stores 'auto' or NULL, fall back to derived basis from requires_* flags.
    const availabilityBasis = rawBasis && rawBasis !== "auto" ? rawBasis : derivedBasis;
;

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
        availability_basis: availabilityBasis,
        derived_basis: derivedBasis,
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
        availability_basis: availabilityBasis,
        derived_basis: derivedBasis,
          reason: "resource_required",
        },
      });
    }

    // Additional requirement: availability basis may require staff/resource even if the service flags don't.
    if ((availabilityBasis === "resource" || availabilityBasis === "both") && !resourceId) {
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
          availability_basis: availabilityBasis,
          derived_basis: derivedBasis,
          reason: "resource_required_for_availability",
        },
      });
    }
    if ((availabilityBasis === "staff" || availabilityBasis === "both") && !staffId) {
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
          availability_basis: availabilityBasis,
          derived_basis: derivedBasis,
          reason: "staff_required_for_availability",
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
        availability_basis: availabilityBasis,
        derived_basis: derivedBasis,
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
        availability_basis: availabilityBasis,
        derived_basis: derivedBasis,
          reason: "invalid_working_hours",
          open_time: openTime,
          close_time: closeTime,
        },
      });
    }

    // 4) Build all candidate slots
    const allSlots = [];
    const availableTimes = [];

    
const openMin = toMinutes(openHHMM);
let closeMin = toMinutes(closeHHMM);

// Support overnight hours (e.g., 18:00 → 02:00 next day)
const isOvernight = closeMin <= openMin;
if (isOvernight) closeMin += 24 * 60;

let cursor = openMin;

// Pills represent slot *segments* (slot_interval_minutes), not full service durations.
// So build candidates at stepMin granularity and mark each segment unavailable if it overlaps.

// Performance: avoid per-slot DB queries.
// Query overlaps for the whole window in one SQL call using generate_series.

const windowStartLocal = `${date} ${openHHMM}:00`;
const windowEndLocal = `${addDaysISO(date, isOvernight ? 1 : 0)} ${closeHHMM}:00`;

if (availabilityBasis === "none") {
  const q = `
    WITH slots AS (
      SELECT
        gs AS slot_start,
        gs + make_interval(mins => $5) AS slot_end
      FROM generate_series(
      ($1::timestamp AT TIME ZONE $4),
      ($2::timestamp AT TIME ZONE $4) - make_interval(mins => $5),
      make_interval(mins => $5)
      ) gs
    )
    SELECT
      to_char(slot_start AT TIME ZONE $4, 'HH24:MI') AS time,
      COUNT(tb.*)::int AS blackout_hits
    FROM slots
    LEFT JOIN tenant_blackouts tb
      ON tb.tenant_id = $3
     AND tb.is_active = TRUE
     AND tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(slot_start, slot_end, '[)')
     AND (
       tb.resource_id IS NULL OR tb.resource_id = $6
     )
    GROUP BY slot_start
    ORDER BY slot_start
  `;
  const r = await pool.query(q, [windowStartLocal, windowEndLocal, tenantId, tenantTz, stepMin, resourceId ?? null]);
  for (const row of r.rows) {
    const startHHMM = row.time;
    const blackoutHits = Number(row.blackout_hits ?? 0);
    const slotObj = {
      time: startHHMM,
      label: startHHMM,
      is_available: blackoutHits === 0,
      available: blackoutHits === 0,
      overlaps: 0,
      overlaps_resource: 0,
      overlaps_staff: 0,
      capacity: maxParallel,
      blackout_hits: blackoutHits,
    };

    allSlots.push(slotObj);
    if (blackoutHits === 0) availableTimes.push(startHHMM);
  }
} else {
  const q = `
    WITH slots AS (
      SELECT
        gs AS slot_start,
        gs + make_interval(mins => $5) AS slot_end
      FROM generate_series(
        ($1::timestamp AT TIME ZONE $4),
        ($2::timestamp AT TIME ZONE $4) - make_interval(mins => $5),
        make_interval(mins => $5)
      ) gs
    )
    SELECT
      to_char(slot_start AT TIME ZONE $4, 'HH24:MI') AS time,
      COUNT(b.*) FILTER (WHERE $6 IN ('resource','both') AND b.resource_id = $7)::int AS overlaps_resource,
      COUNT(b.*) FILTER (WHERE $6 IN ('staff','both') AND b.staff_id = $8)::int AS overlaps_staff,
      COUNT(tb.*)::int AS blackout_hits
    FROM slots
    LEFT JOIN bookings b
      ON b.tenant_id = $3
     AND b.status IN ('pending','confirmed')
     AND b.booking_range && tstzrange(slot_start, slot_end, '[)')
    LEFT JOIN tenant_blackouts tb
      ON tb.tenant_id = $3
     AND tb.is_active = TRUE
     AND tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(slot_start, slot_end, '[)')
     AND (
       tb.resource_id IS NULL OR tb.resource_id = $7
     )
    GROUP BY slot_start
    ORDER BY slot_start;
  `;

  const r = await pool.query(q, [
    windowStartLocal,
    windowEndLocal,
    tenantId,
    tenantTz,
    stepMin,
    availabilityBasis,
    resourceId ?? null,
    staffId ?? null,
  ]);

  for (const row of r.rows) {
    const startHHMM = row.time;
    const overlapsResource = Number(row.overlaps_resource ?? 0);
    const overlapsStaff = Number(row.overlaps_staff ?? 0);
    const blackoutHits = Number(row.blackout_hits ?? 0);

    let isAvailable = true;
    if (availabilityBasis === "resource") {
      isAvailable = overlapsResource < maxParallel;
    } else if (availabilityBasis === "staff") {
      isAvailable = overlapsStaff < maxParallel;
    } else if (availabilityBasis === "both") {
      isAvailable = overlapsResource < maxParallel && overlapsStaff < maxParallel;
    }

    const overlapsCount = availabilityBasis === "both"
      ? Math.max(overlapsResource, overlapsStaff)
      : (availabilityBasis === "staff" ? overlapsStaff : overlapsResource);

    const slotObj = {
      time: startHHMM,
      label: startHHMM,
      is_available: isAvailable && blackoutHits === 0,
      available: isAvailable && blackoutHits === 0,
      overlaps: overlapsCount,
      overlaps_resource: overlapsResource,
      overlaps_staff: overlapsStaff,
      capacity: maxParallel,
      blackout_hits: blackoutHits,
    };

    allSlots.push(slotObj);
    if (isAvailable && blackoutHits === 0) availableTimes.push(startHHMM);
  }
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
        availability_basis: availabilityBasis,
        derived_basis: derivedBasis,
        staffId: staffId ?? null,
        resourceId: resourceId ?? null,
        used_default_hours: usedDefaultHours,
        day_of_week: dayOfWeek,
          open_time: openHHMM,
          close_time: closeHHMM,
          is_overnight: isOvernight,
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
