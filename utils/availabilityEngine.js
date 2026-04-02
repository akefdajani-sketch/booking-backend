// utils/availabilityEngine.js
//
// Core availability logic extracted from routes/availability.js.
// The route handler is now a thin wrapper: parse params → resolve tenant/service
// → call buildAvailabilitySlots() → return res.json().
//
// Keeping logic here means it can be unit-tested independently of Express.

const pool = require("../db");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

function normaliseWindowMinutes(startMinute, endMinute) {
  const start = Number(startMinute);
  let end = Number(endMinute);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start === end) return null;
  if (end <= start) end += 24 * 60;
  return { start_minute: start, end_minute: end };
}

function normaliseSlotMinuteForWindow(slotMinute, openMinute, isOvernight) {
  const slot = Number(slotMinute);
  if (!Number.isFinite(slot)) return slot;
  if (isOvernight && slot < openMinute) return slot + 24 * 60;
  return slot;
}

// Accept YYYY-MM-DD (preferred). Normalises MM/DD/YYYY if a locale date slips through.
function normalizeDateInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${pad2(Number(mdy[1]))}-${pad2(Number(mdy[2]))}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()))
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return s;
}

// Add days to an ISO date (YYYY-MM-DD) and return ISO date.
function addDaysISO(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Staff schedule helper (DB)
// ---------------------------------------------------------------------------

async function loadEffectiveStaffBlocks({ tenantId, staffId, dateISO, weekday }) {
  // Override precedence:
  // 1) Any OFF on date => []
  // 2) If CUSTOM_HOURS exists => use ONLY custom blocks
  // 3) Else weekly blocks + ADD_HOURS blocks
  try {
    const overrides = await pool.query(
      `SELECT type,
              CASE WHEN start_time IS NULL THEN NULL
                   ELSE (EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int)
              END AS start_minute,
              CASE WHEN end_time IS NULL THEN NULL
                   ELSE (EXTRACT(HOUR FROM end_time)::int * 60 + EXTRACT(MINUTE FROM end_time)::int)
              END AS end_minute
         FROM staff_schedule_overrides
        WHERE tenant_id = $1 AND staff_id = $2 AND date = $3::date`,
      [tenantId, staffId, dateISO]
    );
    const rows = overrides.rows || [];
    if (rows.some((r) => String(r.type || "").toUpperCase() === "OFF")) return [];

    const custom = rows.filter((r) => String(r.type || "").toUpperCase() === "CUSTOM_HOURS");
    const add    = rows.filter((r) => String(r.type || "").toUpperCase() === "ADD_HOURS");

    if (custom.length) {
      return custom
        .map((r) => ({ start_minute: Number(r.start_minute), end_minute: Number(r.end_minute) }))
        .filter((b) => Number.isFinite(b.start_minute) && Number.isFinite(b.end_minute));
    }

    const weekly = await pool.query(
      `SELECT (EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int) AS start_minute,
              (EXTRACT(HOUR FROM end_time)::int   * 60 + EXTRACT(MINUTE FROM end_time)::int)   AS end_minute
         FROM staff_weekly_schedule
        WHERE tenant_id = $1 AND staff_id = $2 AND day_of_week = $3
          AND COALESCE(is_off, false) = false
          AND start_time IS NOT NULL AND end_time IS NOT NULL
        ORDER BY start_time ASC`,
      [tenantId, staffId, weekday]
    );

    return [...(weekly.rows || []), ...add]
      .map((r) => ({ start_minute: Number(r.start_minute), end_minute: Number(r.end_minute) }))
      .filter((b) => Number.isFinite(b.start_minute) && Number.isFinite(b.end_minute));
  } catch (err) {
    if (err && err.code === "42P01") return null; // table not yet migrated → preserve old behaviour
    console.error("loadEffectiveStaffBlocks error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildAvailabilitySlots
//
// Core engine. Returns { times, slots, meta } — never throws (errors are caught
// and surfaced as empty slots + meta.error).
//
// @param {object} p
//   tenantId       {number}
//   tenantSlug     {string|null}
//   date           {string}  YYYY-MM-DD (already normalised)
//   serviceId      {number}
//   staffId        {number|null}
//   resourceId     {number|null}
//   tenantTz       {string}
//   service        {object}  full services row
// ---------------------------------------------------------------------------
const DEFAULT_OPEN  = "08:00";
const DEFAULT_CLOSE = "22:00";

async function buildAvailabilitySlots({ tenantId, tenantSlug, date, serviceId, staffId, resourceId, tenantTz, service }) {

  // ── Derive service-level params ───────────────────────────────────────────
  const serviceMinutes = Number(service.minutes ?? service.duration_minutes ?? service.duration ?? 0) || 0;
  const slotInterval   = Number(service.slot_interval_minutes ?? service.slotIntervalMinutes ?? serviceMinutes) || serviceMinutes || 60;
  const durationMin    = serviceMinutes || 60;
  const stepMin        = slotInterval   || durationMin;
  const maxParallel    = Number(service.max_parallel_bookings) || 1;
  const reqStaff       = !!service.requires_staff;
  const reqResource    = !!service.requires_resource;

  const rawBasis     = service.availability_basis ? String(service.availability_basis).toLowerCase() : "";
  const derivedBasis = reqStaff && reqResource ? "both" : reqStaff ? "staff" : reqResource ? "resource" : "none";
  const availabilityBasis = rawBasis && rawBasis !== "auto" ? rawBasis : derivedBasis;

  // Shared meta base (used in all early-exit responses)
  const metaBase = {
    duration_minutes:      durationMin,
    slot_interval_minutes: stepMin,
    max_parallel_bookings: maxParallel,
    requires_staff:        reqStaff,
    requires_resource:     reqResource,
    availability_basis:    availabilityBasis,
    derived_basis:         derivedBasis,
  };

  function emptyResponse(reason, extra = {}) {
    return { times: [], slots: [], meta: { ...metaBase, reason, ...extra } };
  }

  // ── Guard: required staff/resource not yet selected ───────────────────────
  if (reqStaff && !staffId)         return emptyResponse("staff_required");
  if (reqResource && !resourceId)   return emptyResponse("resource_required");
  if ((availabilityBasis === "resource" || availabilityBasis === "both") && !resourceId)
    return emptyResponse("resource_required_for_availability");
  if ((availabilityBasis === "staff" || availabilityBasis === "both") && !staffId)
    return emptyResponse("staff_required_for_availability");

  // ── Day of week ───────────────────────────────────────────────────────────
  const dowDate  = new Date(`${date}T00:00:00Z`);
  const dayOfWeek = dowDate.getUTCDay();

  // ── Tenant working hours ──────────────────────────────────────────────────
  const hoursResult = await pool.query(
    `SELECT open_time, close_time, is_closed
       FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1`,
    [tenantId, dayOfWeek]
  );

  let usedDefaultHours = false;
  if (hoursResult.rows.length === 0) {
    usedDefaultHours = true;
  } else if (hoursResult.rows[0].is_closed) {
    return emptyResponse("tenant_closed");
  }

  const openTime  = hoursResult.rows.length ? hoursResult.rows[0].open_time  : null;
  const closeTime = hoursResult.rows.length ? hoursResult.rows[0].close_time : null;
  const openHHMM  = String(openTime  || DEFAULT_OPEN ).slice(0, 5);
  const closeHHMM = String(closeTime || DEFAULT_CLOSE).slice(0, 5);

  if (!/^\d{2}:\d{2}$/.test(openHHMM) || !/^\d{2}:\d{2}$/.test(closeHHMM)) {
    return emptyResponse("invalid_working_hours", { open_time: openTime, close_time: closeTime });
  }

  // ── Slot window setup ─────────────────────────────────────────────────────
  const openMin  = toMinutes(openHHMM);
  let   closeMin = toMinutes(closeHHMM);
  const isOvernight = closeMin <= openMin;
  if (isOvernight) closeMin += 24 * 60;

  // ── Staff schedule blocks ─────────────────────────────────────────────────
  let staffBlocks         = null;
  let staffWindowTrimmed  = false;
  if (availabilityBasis === "staff" || availabilityBasis === "both") {
    staffBlocks = await loadEffectiveStaffBlocks({ tenantId, staffId, dateISO: date, weekday: dayOfWeek });
    if (Array.isArray(staffBlocks)) {
      if (isOvernight) { staffWindowTrimmed = true; closeMin = 24 * 60; }
      staffBlocks = staffBlocks
        .map((b) => {
          const s = Math.max(openMin, Number(b.start_minute));
          const e = Math.min(closeMin, Number(b.end_minute));
          return { start_minute: s, end_minute: e };
        })
        .filter((b) => Number.isFinite(b.start_minute) && Number.isFinite(b.end_minute) && b.end_minute > b.start_minute);

      if (!staffBlocks.length)
        return emptyResponse("staff_unavailable", { staff_window_trimmed: staffWindowTrimmed });
    }
  }

  // ── Service hours windows (PR-SH1) ────────────────────────────────────────
  let serviceHoursWindows = null;
  try {
    try {
      const closedResult = await pool.query(
        `SELECT 1 FROM service_closed_days
          WHERE service_id = $1 AND tenant_id = $2 AND day_of_week = $3 LIMIT 1`,
        [serviceId, tenantId, dayOfWeek]
      );
      if (closedResult.rows.length > 0) return emptyResponse("service_day_disabled");
    } catch (closedErr) {
      if (!closedErr || closedErr.code !== "42P01") throw closedErr;
    }

    const shResult = await pool.query(
      `SELECT (EXTRACT(HOUR FROM open_time)::int  * 60 + EXTRACT(MINUTE FROM open_time)::int)  AS start_minute,
              (EXTRACT(HOUR FROM close_time)::int * 60 + EXTRACT(MINUTE FROM close_time)::int) AS end_minute
         FROM service_hours
        WHERE service_id = $1 AND tenant_id = $2 AND day_of_week = $3
        ORDER BY open_time ASC`,
      [serviceId, tenantId, dayOfWeek]
    );
    if (shResult.rows.length > 0) {
      serviceHoursWindows = shResult.rows
        .map((r) => normaliseWindowMinutes(r.start_minute, r.end_minute))
        .filter(Boolean)
        .map((r) => ({
          start_minute: Math.max(openMin, r.start_minute),
          end_minute:   Math.min(closeMin, r.end_minute),
        }))
        .filter((w) => Number.isFinite(w.start_minute) && Number.isFinite(w.end_minute) && w.end_minute > w.start_minute);

      if (serviceHoursWindows.length === 0)
        return emptyResponse("service_hours_outside_business_hours");
    }
  } catch (shErr) {
    if (!shErr || shErr.code !== "42P01") console.error("serviceHours load error:", shErr);
    serviceHoursWindows = null;
  }

  // ── Generation windows ────────────────────────────────────────────────────
  const fullWindowStart = `${date} ${openHHMM}:00`;
  const fullWindowEnd   = `${addDaysISO(date, isOvernight ? 1 : 0)} ${closeHHMM}:00`;

  const generationWindows = serviceHoursWindows === null || serviceHoursWindows.length === 0
    ? [{ startLocal: fullWindowStart, endLocal: fullWindowEnd }]
    : serviceHoursWindows.map((w) => {
        const startHH    = minutesToHHMM(w.start_minute % (24 * 60));
        const endTotalMin = w.end_minute;
        const endDayOff  = endTotalMin >= 24 * 60 ? 1 : (isOvernight ? 1 : 0);
        const endHH      = minutesToHHMM(endTotalMin % (24 * 60));
        return {
          startLocal: `${date} ${startHH}:00`,
          endLocal:   `${addDaysISO(date, endDayOff)} ${endHH}:00`,
        };
      });

  function slotFallsWithinServiceHours(startHHMM) {
    if (serviceHoursWindows === null) return true;
    const base  = toMinutes(startHHMM);
    const start = normaliseSlotMinuteForWindow(base, openMin, isOvernight);
    const end   = start + stepMin;
    return serviceHoursWindows.some((w) => start >= w.start_minute && end <= w.end_minute);
  }

  // ── Slot generation ───────────────────────────────────────────────────────
  const allSlots      = [];
  const availableTimes = [];
  const useStaffBlocks = Array.isArray(staffBlocks) && (availabilityBasis === "staff" || availabilityBasis === "both");

  for (const genWindow of generationWindows) {
    const { startLocal, endLocal } = genWindow;

    if (availabilityBasis === "none") {
      // ── basis=none: only blackout check, no booking overlap ───────────────
      const q = `
        WITH slots AS (
          SELECT gs AS slot_start, gs + make_interval(mins => $5) AS slot_end
            FROM generate_series(
              ($1::timestamp AT TIME ZONE $4),
              ($2::timestamp AT TIME ZONE $4) - make_interval(mins => $5),
              make_interval(mins => $5)
            ) gs
        )
        SELECT to_char(slot_start AT TIME ZONE $4, 'HH24:MI') AS time,
               COUNT(tb.*)::int AS blackout_hits
          FROM slots
          LEFT JOIN tenant_blackouts tb
            ON tb.tenant_id = $3 AND tb.is_active = TRUE
           AND tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(slot_start, slot_end, '[)')
           AND (tb.resource_id IS NULL OR tb.resource_id = $6)
          GROUP BY slot_start ORDER BY slot_start`;

      const r = await pool.query(q, [startLocal, endLocal, tenantId, tenantTz, stepMin, resourceId ?? null]);
      for (const row of r.rows) {
        if (!slotFallsWithinServiceHours(row.time)) continue;
        const blackoutHits = Number(row.blackout_hits ?? 0);
        const avail = blackoutHits === 0;
        allSlots.push({
          time: row.time, label: row.time,
          is_available: avail, available: avail,
          overlaps: 0, overlaps_resource: 0, overlaps_staff: 0,
          capacity: maxParallel, blackout_hits: blackoutHits,
        });
        if (avail) availableTimes.push(row.time);
      }

    } else {
      // ── basis=resource/staff/both: booking overlap check ──────────────────
      let q, params;

      // Clip staff blocks to current generation window
      const effectiveStaffBlocks = useStaffBlocks
        ? staffBlocks
            .map((b) => {
              const genStart = toMinutes(startLocal.slice(11, 16));
              const genEnd   = toMinutes(endLocal.slice(11, 16)) || 24 * 60;
              const s = Math.max(Number(b.start_minute), genStart);
              const e = Math.min(Number(b.end_minute),   genEnd);
              return e > s ? { start_minute: s, end_minute: e } : null;
            })
            .filter(Boolean)
        : staffBlocks;

      if (useStaffBlocks && effectiveStaffBlocks.length === 0) continue;

      if (useStaffBlocks) {
        // Generate slots per staff block using LATERAL generate_series
        const values = [];
        params = [tenantTz];
        let p = params.length + 1;
        for (const b of effectiveStaffBlocks) {
          params.push(`${date} ${minutesToHHMM(Number(b.start_minute))}:00`);
          params.push(`${date} ${minutesToHHMM(Number(b.end_minute))}:00`);
          values.push(`(($${p++})::timestamp, ($${p++})::timestamp)`);
        }
        const tzIdx = 1, tenantIdIdx = p++, stepIdx = p++, basisIdx = p++,
              resourceIdx = p++, staffIdx = p++, serviceIdIdx = p++;
        params.push(tenantId, stepMin, availabilityBasis, resourceId ?? null, staffId ?? null, serviceId ?? null);

        q = `
          WITH working_blocks(start_local, end_local) AS (VALUES ${values.join(",")}),
          slots AS (
            SELECT gs AS slot_start, gs + make_interval(mins => $${stepIdx}) AS slot_end
              FROM working_blocks wb
              CROSS JOIN LATERAL generate_series(
                (wb.start_local AT TIME ZONE $${tzIdx}),
                (wb.end_local   AT TIME ZONE $${tzIdx}) - make_interval(mins => $${stepIdx}),
                make_interval(mins => $${stepIdx})
              ) gs
          )
          SELECT to_char(slot_start AT TIME ZONE $${tzIdx}, 'HH24:MI') AS time,
                 COUNT(b.*) FILTER (WHERE $${basisIdx} IN ('resource','both') AND b.resource_id = $${resourceIdx})::int AS overlaps_resource,
                 COUNT(b.*) FILTER (WHERE $${basisIdx} IN ('staff','both')    AND b.staff_id   = $${staffIdx})::int    AS overlaps_staff,
                 COUNT(tb.*)::int AS blackout_hits,
                 MAX(ss.confirmed_count) FILTER (WHERE ss.resource_id = $${resourceIdx}) AS session_confirmed,
                 MAX(ss.max_capacity)    FILTER (WHERE ss.resource_id = $${resourceIdx}) AS session_capacity,
                 MAX(ss.id)              FILTER (WHERE ss.resource_id = $${resourceIdx}) AS session_id,
                 MAX(ss.status)          FILTER (WHERE ss.resource_id = $${resourceIdx}) AS session_status,
                 COUNT(b.*) FILTER (WHERE $${basisIdx} IN ('resource','both') AND b.resource_id = $${resourceIdx} AND b.service_id <> $${serviceIdIdx})::int AS overlaps_other_service
            FROM slots
            LEFT JOIN bookings b
              ON b.tenant_id = $${tenantIdIdx} AND b.status IN ('pending','confirmed')
             AND b.booking_range && tstzrange(slot_start, slot_end, '[)')
             AND b.deleted_at IS NULL
            LEFT JOIN service_sessions ss
              ON ss.tenant_id = $${tenantIdIdx} AND ss.resource_id = $${resourceIdx} AND ss.service_id = $${serviceIdIdx}
             AND ss.status <> 'cancelled'
             AND tstzrange(ss.start_time, ss.start_time + make_interval(mins => ss.duration_minutes), '[)') && tstzrange(slot_start, slot_end, '[)')
            LEFT JOIN tenant_blackouts tb
              ON tb.tenant_id = $${tenantIdIdx} AND tb.is_active = TRUE
             AND tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(slot_start, slot_end, '[)')
             AND (tb.resource_id IS NULL OR tb.resource_id = $${resourceIdx})
            GROUP BY slot_start ORDER BY slot_start`;

      } else {
        q = `
          WITH slots AS (
            SELECT gs AS slot_start, gs + make_interval(mins => $5) AS slot_end
              FROM generate_series(
                ($1::timestamp AT TIME ZONE $4),
                ($2::timestamp AT TIME ZONE $4) - make_interval(mins => $5),
                make_interval(mins => $5)
              ) gs
          )
          SELECT to_char(slot_start AT TIME ZONE $4, 'HH24:MI') AS time,
                 COUNT(b.*) FILTER (WHERE $6 IN ('resource','both') AND b.resource_id = $7)::int AS overlaps_resource,
                 COUNT(b.*) FILTER (WHERE $6 IN ('staff','both')    AND b.staff_id   = $8)::int AS overlaps_staff,
                 COUNT(tb.*)::int AS blackout_hits,
                 MAX(ss.confirmed_count) FILTER (WHERE ss.resource_id = $7) AS session_confirmed,
                 MAX(ss.max_capacity)    FILTER (WHERE ss.resource_id = $7) AS session_capacity,
                 MAX(ss.id)              FILTER (WHERE ss.resource_id = $7) AS session_id,
                 MAX(ss.status)          FILTER (WHERE ss.resource_id = $7) AS session_status,
                 COUNT(b.*) FILTER (WHERE $6 IN ('resource','both') AND b.resource_id = $7 AND b.service_id <> $9)::int AS overlaps_other_service
            FROM slots
            LEFT JOIN bookings b
              ON b.tenant_id = $3 AND b.status IN ('pending','confirmed')
             AND b.booking_range && tstzrange(slot_start, slot_end, '[)')
             AND b.deleted_at IS NULL
            LEFT JOIN service_sessions ss
              ON ss.tenant_id = $3 AND ss.resource_id = $7 AND ss.service_id = $9
             AND ss.status <> 'cancelled'
             AND tstzrange(ss.start_time, ss.start_time + make_interval(mins => ss.duration_minutes), '[)') && tstzrange(slot_start, slot_end, '[)')
            LEFT JOIN tenant_blackouts tb
              ON tb.tenant_id = $3 AND tb.is_active = TRUE
             AND tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(slot_start, slot_end, '[)')
             AND (tb.resource_id IS NULL OR tb.resource_id = $7)
            GROUP BY slot_start ORDER BY slot_start`;
        params = [startLocal, endLocal, tenantId, tenantTz, stepMin, availabilityBasis, resourceId ?? null, staffId ?? null, serviceId ?? null];
      }

      const r = await pool.query(q, params);

      for (const row of r.rows) {
        // Service hours filter
        if (serviceHoursWindows !== null) {
          const base  = toMinutes(row.time);
          const start = normaliseSlotMinuteForWindow(base, openMin, isOvernight);
          if (!serviceHoursWindows.some((w) => start >= w.start_minute && start + stepMin <= w.end_minute)) continue;
        }

        const overlapsResource   = Number(row.overlaps_resource    ?? 0);
        const overlapsStaff      = Number(row.overlaps_staff       ?? 0);
        const blackoutHits       = Number(row.blackout_hits        ?? 0);
        const overlapsOtherSvc   = Number(row.overlaps_other_service ?? 0);
        const sessionConfirmed   = row.session_confirmed != null ? Number(row.session_confirmed) : null;
        const sessionCapacity    = row.session_capacity  != null ? Number(row.session_capacity)  : null;
        const sessionId          = row.session_id        != null ? Number(row.session_id)        : null;
        const sessionStatus      = row.session_status    ?? null;
        const isParallelService  = maxParallel > 1;

        let isAvailable = true;
        if (isParallelService && availabilityBasis === "resource") {
          if (overlapsOtherSvc > 0)                                         isAvailable = false;
          else if (sessionStatus === "full")                                 isAvailable = false;
          else if (sessionConfirmed !== null && sessionCapacity !== null)   isAvailable = sessionConfirmed < sessionCapacity;
        } else if (availabilityBasis === "resource") {
          isAvailable = overlapsResource < maxParallel;
        } else if (availabilityBasis === "staff") {
          isAvailable = overlapsStaff < maxParallel;
        } else if (availabilityBasis === "both") {
          isAvailable = overlapsResource < maxParallel && overlapsStaff < maxParallel;
        }

        const overlapsCount = availabilityBasis === "both"
          ? Math.max(overlapsResource, overlapsStaff)
          : availabilityBasis === "staff" ? overlapsStaff : overlapsResource;

        const spotsRemaining = isParallelService
          ? (sessionConfirmed !== null && sessionCapacity !== null ? sessionCapacity - sessionConfirmed : maxParallel)
          : null;

        const avail = isAvailable && blackoutHits === 0;
        allSlots.push({
          time: row.time, label: row.time,
          is_available: avail, available: avail,
          overlaps: overlapsCount, overlaps_resource: overlapsResource, overlaps_staff: overlapsStaff,
          capacity: maxParallel, blackout_hits: blackoutHits,
          session_id: sessionId, spots_remaining: spotsRemaining,
          total_capacity: isParallelService ? maxParallel : null,
        });
        if (avail) availableTimes.push(row.time);
      }
    }
  }

  // ── Deduplicate (multiple generation windows may overlap) ─────────────────
  const seenTimes = new Set();
  const dedupedSlots = allSlots.filter((s) => {
    if (seenTimes.has(s.time)) return false;
    seenTimes.add(s.time);
    return true;
  });
  const seenAvail = new Set();
  const dedupedTimes = availableTimes.filter((t) => {
    if (seenAvail.has(t)) return false;
    seenAvail.add(t);
    return true;
  });

  // ── Final service-hours filter ────────────────────────────────────────────
  const finalSlots = serviceHoursWindows !== null
    ? dedupedSlots.filter((s) => slotFallsWithinServiceHours(s.time))
    : dedupedSlots;
  const finalTimes = serviceHoursWindows !== null
    ? dedupedTimes.filter((t) => slotFallsWithinServiceHours(t))
    : dedupedTimes;

  return {
    times: finalTimes,
    slots: finalSlots,
    meta: {
      ...metaBase,
      staffId:          staffId   ?? null,
      resourceId:       resourceId ?? null,
      used_default_hours: usedDefaultHours,
      day_of_week:      dayOfWeek,
      open_time:        openHHMM,
      close_time:       closeHHMM,
      is_overnight:     isOvernight,
    },
  };
}

module.exports = { buildAvailabilitySlots, normalizeDateInput };
