// utils/ratesEngine.js
// Centralized rate rule selection + pricing application.
//
// Time comparison uses the tenant's local timezone (via Intl.DateTimeFormat)
// so that rate rules configured in local time (e.g. "16:00–00:00 Peak Hours")
// match correctly regardless of server UTC offset or the client's timezone.

const { pool } = require("../db");
const db = pool;

function round2(n) {
  if (n == null) return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

/**
 * Convert a UTC Date to local date/time strings for a given IANA timezone.
 * Falls back to UTC if timezone is invalid or Intl is unavailable.
 *
 * Returns { dateStr: "YYYY-MM-DD", timeStr: "HH:MM:SS", dow: 0-6 }
 */
function toLocalParts(date, timezone) {
  try {
    const tz = timezone && String(timezone).trim() ? timezone : "UTC";

    // Use Intl to extract the local wall-clock parts.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = fmt.formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";

    const year   = get("year");
    const month  = get("month");
    const day    = get("day");
    let   hour   = get("hour");
    const minute = get("minute");
    const second = get("second");

    // Intl may return "24" for midnight — normalise to "00".
    if (hour === "24") hour = "00";

    const dateStr = `${year}-${month}-${day}`;
    const timeStr = `${hour}:${minute}:${second}`;

    // Derive day-of-week from the local date string.
    const localMidnight = new Date(`${dateStr}T00:00:00`);
    const dow = localMidnight.getDay(); // 0=Sun … 6=Sat

    return { dateStr, timeStr, dow };
  } catch {
    // Safe fallback: UTC
    const iso = date.toISOString();
    return {
      dateStr: iso.slice(0, 10),
      timeStr: iso.slice(11, 19),
      dow:     date.getUTCDay(),
    };
  }
}

function isWithinDateRange(startDateStr, dateStart, dateEnd) {
  if (!dateStart && !dateEnd) return true;
  if (dateStart && startDateStr < dateStart) return false;
  if (dateEnd   && startDateStr > dateEnd)   return false;
  return true;
}

function isWithinTimeWindow(startTimeStr, timeStart, timeEnd) {
  if (!timeStart && !timeEnd) return true;
  if (timeStart && timeEnd) {
    // Handle windows that wrap midnight (e.g. 22:00 → 02:00).
    if (timeEnd < timeStart) {
      return startTimeStr >= timeStart || startTimeStr <= timeEnd;
    }
    return startTimeStr >= timeStart && startTimeStr <= timeEnd;
  }
  if (timeStart) return startTimeStr >= timeStart;
  if (timeEnd)   return startTimeStr <= timeEnd;
  return true;
}

function matchesDuration(durationMinutes, minDur, maxDur) {
  if (minDur != null && durationMinutes < Number(minDur)) return false;
  if (maxDur != null && durationMinutes > Number(maxDur)) return false;
  return true;
}

function specificityScore(rule) {
  let s = 0;
  if (rule.service_id  != null) s += 10;
  if (rule.staff_id    != null) s += 5;
  if (rule.resource_id != null) s += 3;
  return s;
}

function applyRule(basePriceAmount, rule) {
  const base = Number(basePriceAmount);
  if (!Number.isFinite(base)) return { adjusted: null, reason: "missing_base" };
  const amt = Number(rule.amount);
  if (!Number.isFinite(amt)) return { adjusted: round2(base), reason: "invalid_amount" };

  const t = String(rule.price_type || "").toLowerCase();
  if (t === "fixed")      return { adjusted: round2(amt),        reason: "fixed" };
  if (t === "delta")      return { adjusted: round2(base + amt), reason: "delta" };
  if (t === "multiplier") return { adjusted: round2(base * amt), reason: "multiplier" };
  return { adjusted: round2(base), reason: "unknown_type" };
}

async function loadRules({ tenantId, serviceId, staffId, resourceId }) {
  const { rows } = await db.query(
    `
    SELECT
      id, name, is_active,
      service_id, staff_id, resource_id,
      currency_code, price_type, amount,
      days_of_week, time_start, time_end,
      date_start, date_end,
      min_duration_mins, max_duration_mins,
      priority,
      COALESCE(metadata, '{}'::jsonb) AS metadata
    FROM rate_rules
    WHERE tenant_id = $1
      AND COALESCE(is_active,true) = true
      AND (service_id  IS NULL OR service_id  = $2)
      AND (staff_id    IS NULL OR staff_id    = $3)
      AND (resource_id IS NULL OR resource_id = $4)
    `,
    [tenantId, serviceId || null, staffId || null, resourceId || null]
  );
  return rows;
}

/**
 * Load the tenant's configured timezone from the DB.
 * Returns a valid IANA timezone string, or "UTC" as fallback.
 */
async function loadTenantTimezone(tenantId) {
  try {
    const { rows } = await db.query(
      `SELECT timezone FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const tz = String(rows?.[0]?.timezone || "").trim();
    if (!tz) return "UTC";
    // Validate it's a real IANA timezone before returning.
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

async function computeRateForBookingLike({
  tenantId,
  serviceId,
  staffId,
  resourceId,
  start,
  durationMinutes,
  basePriceAmount,
}) {
  const base = basePriceAmount == null ? null : round2(basePriceAmount);

  // Resolve tenant timezone so time-window rules match local wall-clock time.
  const timezone = await loadTenantTimezone(tenantId);
  const { dateStr, timeStr, dow } = toLocalParts(start, timezone);

  const rules = await loadRules({ tenantId, serviceId, staffId, resourceId });

  const matches = rules
    .filter((r) => {
      // DOW — compare against local day-of-week
      if (Array.isArray(r.days_of_week) && r.days_of_week.length) {
        if (!r.days_of_week.map(Number).includes(dow)) return false;
      }
      // Date range — local date
      if (!isWithinDateRange(dateStr, r.date_start, r.date_end)) return false;
      // Time window — local time vs stored rule times
      if (!isWithinTimeWindow(timeStr, r.time_start, r.time_end)) return false;
      // Duration
      if (!matchesDuration(durationMinutes, r.min_duration_mins, r.max_duration_mins)) return false;
      return true;
    })
    .sort((a, b) => {
      const pa = Number(a.priority || 0);
      const pb = Number(b.priority || 0);
      if (pb !== pa) return pb - pa;
      const sa = specificityScore(a);
      const sb = specificityScore(b);
      if (sb !== sa) return sb - sa;
      return Number(b.id) - Number(a.id);
    });

  const winner  = matches[0] || null;
  const applied = winner
    ? applyRule(base, winner)
    : { adjusted: base, reason: "no_rule" };

  const startIso = start.toISOString();
  const snapshot = {
    computed_at: new Date().toISOString(),
    timezone_used: timezone,
    inputs: {
      service_id:        serviceId || null,
      staff_id:          staffId   || null,
      resource_id:       resourceId || null,
      start_time:        startIso,
      local_date:        dateStr,
      local_time:        timeStr,
      local_dow:         dow,
      duration_minutes:  durationMinutes,
      base_price_amount: base,
    },
    rule: winner
      ? {
          id:               winner.id,
          name:             winner.name,
          service_id:       winner.service_id,
          staff_id:         winner.staff_id,
          resource_id:      winner.resource_id,
          currency_code:    winner.currency_code,
          price_type:       winner.price_type,
          amount:           winner.amount,
          days_of_week:     winner.days_of_week,
          time_start:       winner.time_start,
          time_end:         winner.time_end,
          date_start:       winner.date_start,
          date_end:         winner.date_end,
          min_duration_mins: winner.min_duration_mins,
          max_duration_mins: winner.max_duration_mins,
          priority:         winner.priority,
        }
      : null,
    result: {
      adjusted_price_amount: applied.adjusted,
      reason:                applied.reason,
    },
  };

  return {
    base_price_amount:      base,
    adjusted_price_amount:  applied.adjusted,
    applied_rate_rule_id:   winner ? winner.id : null,
    applied_rate_snapshot:  snapshot,
  };
}

module.exports = {
  computeRateForBookingLike,
};
