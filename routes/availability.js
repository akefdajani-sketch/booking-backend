// routes/availability.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { getTenantIdFromSlug } = require("../utils/tenants");

// ---------- Timezone helpers (no extra deps) ------------------------------

function getTzOffsetMinutes(date, timeZone) {
  // Returns (local_time_in_tz - utc_time) in minutes for the given instant
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = dtf.formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  return (asUTC - date.getTime()) / 60000;
}

function localDateTimeToUTCISO(dateStr, timeStr, timeZone) {
  // dateStr: YYYY-MM-DD, timeStr: HH:MM
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);

  // First guess: treat local components as UTC
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));

  // Compute timezone offset at that instant and correct
  const offsetMin = getTzOffsetMinutes(guess, timeZone);
  const corrected = new Date(guess.getTime() - offsetMin * 60000);

  return corrected.toISOString();
}

function dayOfWeekInTZ(dateStr, timeZone) {
  // Use local noon (stable vs DST edges) to compute weekday
  const iso = localDateTimeToUTCISO(dateStr, "12:00", timeZone);
  const d = new Date(iso);

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  });
  const wd = dtf.format(d); // "Sun", "Mon", ...
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

// -------------------------------------------------------------------------
// GET /api/availability?tenantSlug=&serviceId=&date=YYYY-MM-DD&staffId=&resourceId=
// Returns slots including unavailable ones (grey pills in UI)
// -------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, tenantId, serviceId, date, staffId, resourceId } = req.query;

    if (!date || !serviceId) {
      return res.status(400).json({ error: "date and serviceId are required." });
    }

    // Resolve tenantId
    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "tenantSlug or tenantId is required." });
    }

    const serviceIdNum = Number(serviceId);
    const staffIdNum = staffId ? Number(staffId) : null;
    const resourceIdNum = resourceId ? Number(resourceId) : null;

    // Tenant timezone (fallback to UTC if missing)
    const tzRow = await db.query(`SELECT timezone FROM tenants WHERE id = $1`, [
      resolvedTenantId,
    ]);
    const timeZone = tzRow.rows?.[0]?.timezone || "UTC";

    // Service duration
    const svc = await db.query(
      `SELECT id, duration_minutes FROM services WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [resolvedTenantId, serviceIdNum]
    );
    const durationMinutes = Number(svc.rows?.[0]?.duration_minutes || 0);
    if (!durationMinutes || durationMinutes < 1) {
      return res.status(400).json({ error: "Service has invalid duration." });
    }

    // Day-of-week in TENANT timezone (not UTC)
    const dow = dayOfWeekInTZ(String(date), timeZone);

    // Working hours for that day
    const hoursRes = await db.query(
      `
      SELECT open_time, close_time, is_closed
      FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1
      `,
      [resolvedTenantId, dow]
    );

    // ✅ Safe fallback so you never get "zero pills" just because hours are missing
    const DEFAULT_OPEN = "08:00";
    const DEFAULT_CLOSE = "22:00";

    let openHHMM = DEFAULT_OPEN;
    let closeHHMM = DEFAULT_CLOSE;

    const hourRow = hoursRes.rows?.[0] || null;

    if (hourRow?.is_closed) {
      return res.json({ slots: [] });
    }

    if (hourRow?.open_time && hourRow?.close_time) {
      // open_time may be "08:00:00" → keep HH:MM
      openHHMM = String(hourRow.open_time).slice(0, 5);
      closeHHMM = String(hourRow.close_time).slice(0, 5);
    }

    // Build slots in 15-min increments
    const step = 15;

    const toMinutes = (hhmm) => {
      const [h, m] = hhmm.split(":").map(Number);
      return h * 60 + m;
    };

    const fromMinutes = (mins) => {
      const h = String(Math.floor(mins / 60)).padStart(2, "0");
      const m = String(mins % 60).padStart(2, "0");
      return `${h}:${m}`;
    };

    const openMin = toMinutes(openHHMM);
    const closeMin = toMinutes(closeHHMM);

    const slots = [];
    for (let cursor = openMin; cursor <= closeMin - durationMinutes; cursor += step) {
      const startHHMM = fromMinutes(cursor);
      const endHHMM = fromMinutes(cursor + durationMinutes);

      // ✅ Convert slot start/end from tenant-local → UTC ISO to compare with stored bookings
      const slotStartISO = localDateTimeToUTCISO(String(date), startHHMM, timeZone);
      const slotEndISO = localDateTimeToUTCISO(String(date), endHHMM, timeZone);

      // ✅ IMPORTANT: Do NOT filter overlaps by service_id
      // Overlaps should block by resource/staff regardless of service
      const overlap = await db.query(
        `
        SELECT 1
        FROM bookings b
        WHERE b.tenant_id = $1
          AND COALESCE(b.status,'') NOT IN ('cancelled','canceled')
          AND b.start_time < $2
          AND (b.start_time + (b.duration_minutes || ' minutes')::interval) > $3
          AND ($4::int IS NULL OR b.staff_id = $4)
          AND ($5::int IS NULL OR b.resource_id = $5)
        LIMIT 1
        `,
        [resolvedTenantId, slotEndISO, slotStartISO, staffIdNum, resourceIdNum]
      );

      const available = overlap.rowCount === 0;

      slots.push({
        time: startHHMM,
        label: startHHMM,
        available,
        is_available: available, // keep backwards compat if any old code reads this
      });
    }

    return res.json({ slots });
  } catch (err) {
    console.error("GET /api/availability error:", err);
    return res.status(500).json({ error: "Failed to load availability." });
  }
});

module.exports = router;
