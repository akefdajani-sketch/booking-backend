// utils/ratesEngine.js
// Centralized rate rule selection + pricing application.
//
// Time comparison uses the tenant's local timezone (via Intl.DateTimeFormat)
// so that rate rules configured in local time (e.g. "16:00–00:00 Peak Hours")
// match correctly regardless of server UTC offset or the client's timezone.

const { pool } = require("../db");
const db = pool;

/**
 * Load tenant timezone (IANA string) from tenants table.
 * Falls back to "UTC" if missing/invalid.
 */
async function loadTenantTimezone(tenantId) {
  try {
    const r = await db.query(`SELECT timezone FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
    const tz = r.rows?.[0]?.timezone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : "UTC";
  } catch (_e) {
    return "UTC";
  }
}

/**
 * Load active rate rules for a booking context.
 * Rules may target a specific service/staff/resource or be global (NULL).
 */
async function loadRules({ tenantId, serviceId, staffId, resourceId }) {
  const params = [tenantId, serviceId, staffId, resourceId];
  const q = `
    SELECT
      id,
      tenant_id,
      name,
      is_active,
      service_id,
      staff_id,
      resource_id,
      currency_code,
      price_type,
      amount,
      days_of_week,
      time_start,
      time_end,
      date_start,
      date_end,
      min_duration_mins,
      max_duration_mins,
      priority,
      metadata,
      created_at,
      updated_at
    FROM rate_rules
    WHERE tenant_id = $1
      AND COALESCE(is_active, false) = true
      AND ($2::int IS NULL OR service_id IS NULL OR service_id = $2::int)
      AND ($3::int IS NULL OR staff_id   IS NULL OR staff_id   = $3::int)
      AND ($4::int IS NULL OR resource_id IS NULL OR resource_id = $4::int)
  `;
  const r = await db.query(q, params);

  return r.rows.map((row) => {
    // Normalize days_of_week from Postgres array / CSV-ish strings.
    let dows = row.days_of_week;
    if (typeof dows === "string") {
      const s = dows.trim();
      if (s.startsWith("{") && s.endsWith("}")) {
        dows = s
          .slice(1, -1)
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n));
      } else {
        dows = s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n));
      }
    }
    if (Array.isArray(dows) && dows.length === 0) dows = null;

    let meta = row.metadata;
    if (typeof meta === "string") {
      try {
        meta = JSON.parse(meta);
      } catch (_e) {
        // leave as string
      }
    }

    return { ...row, days_of_week: dows, metadata: meta };
  });
}

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

function parseTimeToMinutes(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Accept "HH:MM", "HH:MM:SS", and "hh:mm AM/PM".
  const m12 = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)$/i);
  if (m12) {
    let h = Number(m12[1]);
    const min = Number(m12[2]);
    const ap = String(m12[4]).toUpperCase();
    if (ap === "AM") {
      if (h === 12) h = 0;
    } else {
      if (h !== 12) h += 12;
    }
    return h * 60 + min;
  }

  const m24 = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m24) {
    const h = Number(m24[1]);
    const min = Number(m24[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    return h * 60 + min;
  }

  return null;
}

function isWithinTimeWindow(startTimeStr, timeStart, timeEnd) {
  if (!timeStart && !timeEnd) return true;

  const t = parseTimeToMinutes(startTimeStr);
  const s = parseTimeToMinutes(timeStart);
  const e = parseTimeToMinutes(timeEnd);

  // If parsing fails, fall back to string compare (legacy behavior).
  // IMPORTANT: end is treated as exclusive to avoid overlap at boundaries (e.g. Off-Peak ending at 16:00).
  if (t == null || (timeStart && s == null) || (timeEnd && e == null)) {
    const st = String(startTimeStr);
    const ss = timeStart != null ? String(timeStart) : null;
    const se = timeEnd != null ? String(timeEnd) : null;

    if (ss && se) {
      if (se < ss) {
        // Wraps midnight: [start, 24h) U [0, end)
        return st >= ss || st < se;
      }
      return st >= ss && st < se;
    }
    if (ss) return st >= ss;
    if (se) return st < se;
    return true;
  }

  if (s != null && e != null) {
    // Handle windows that wrap midnight (e.g. 22:00 → 02:00).
    // Treat end as exclusive: [start, 24h) U [0, end)
    if (e < s) return t >= s || t < e;
    // Normal window: [start, end)
    return t >= s && t < e;
  }
  if (s != null) return t >= s;
  if (e != null) return t < e;
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

function applyRule(basePriceAmount, rule, durationMinutes, serviceSlotMinutes) {
  const amt = Number(rule.amount);
  if (!Number.isFinite(amt)) return { adjusted: round2(Number(basePriceAmount) || 0), reason: "invalid_amount" };

  const t = String(rule.price_type || "").toLowerCase();

  if (t === "fixed") {
    // Package rule: when min_duration === max_duration the amount IS the total
    // price for that exact booking length — do NOT multiply by slot count.
    const minD = rule.min_duration_mins != null ? Number(rule.min_duration_mins) : null;
    const maxD = rule.max_duration_mins != null ? Number(rule.max_duration_mins) : null;
    if (minD != null && maxD != null && minD === maxD && minD > 0) {
      return { adjusted: round2(amt), reason: "fixed_package" };
    }

    // Per-slot fixed rate: scale amount by number of slots selected.
    const slotUnit = Number(serviceSlotMinutes) || 0;
    const dur = Number(durationMinutes) || 0;
    if (slotUnit > 0 && dur > 0 && dur !== slotUnit) {
      return { adjusted: round2(amt * (dur / slotUnit)), reason: "fixed_scaled" };
    }
    return { adjusted: round2(amt), reason: "fixed" };
  }

  // Delta and Multiplier require a base price.
  const base = Number(basePriceAmount);
  if (!Number.isFinite(base)) return { adjusted: null, reason: "missing_base" };

  if (t === "delta")      return { adjusted: round2(base + amt), reason: "delta" };
  if (t === "multiplier") return { adjusted: round2(base * amt), reason: "multiplier" };

  return { adjusted: round2(base), reason: "unknown_type" };
}


async function computeRateForBookingLike({
  tenantId,
  serviceId,
  staffId,
  resourceId,
  start,
  durationMinutes,
  basePriceAmount,
  serviceSlotMinutes,
}) {
  const base = basePriceAmount == null ? null : round2(basePriceAmount);

  const slotUnit = Number(serviceSlotMinutes) > 0 ? Number(serviceSlotMinutes) : Number(durationMinutes) || 0;
  const totalMins = Number(durationMinutes) || 0;

  const timezone = await loadTenantTimezone(tenantId);
  const rules = await loadRules({ tenantId, serviceId, staffId, resourceId });

  if (!slotUnit || !totalMins) {
    return {
      base_price_amount: base,
      adjusted_price_amount: base,
      applied_rate_rule_id: null,
      applied_rate_snapshot: {
        computed_at: new Date().toISOString(),
        timezone_used: timezone,
        mode: "invalid_input",
        inputs: { tenantId, serviceId, staffId, resourceId, start_time: start?.toISOString?.(), duration_minutes: totalMins, service_slot_minutes: slotUnit, base_price_amount: base },
      },
    };
  }

  const slotCount = Math.max(1, Math.ceil(totalMins / slotUnit));
  const slotStarts = Array.from({ length: slotCount }, (_, i) => new Date(start.getTime() + i * slotUnit * 60_000));
  const slotParts = slotStarts.map((d) => toLocalParts(d, timezone));

  function ruleMatchesLocalInstant(rule, parts) {
    const { dateStr, timeStr, dow } = parts;

    if (Array.isArray(rule.days_of_week) && rule.days_of_week.length) {
      if (!rule.days_of_week.map(Number).includes(dow)) return false;
    }
    if (!isWithinDateRange(dateStr, rule.date_start, rule.date_end)) return false;
    if (!isWithinTimeWindow(timeStr, rule.time_start, rule.time_end)) return false;
    return true;
  }

  function ruleWinnerForSegment(fromIdx, lenSlots) {
    const segMins = lenSlots * slotUnit;

    const matches = rules
      .filter((r) => {
        if (!matchesDuration(segMins, r.min_duration_mins, r.max_duration_mins)) return false;
        for (let i = fromIdx; i < fromIdx + lenSlots; i += 1) {
          if (!ruleMatchesLocalInstant(r, slotParts[i])) return false;
        }
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

    return matches[0] || null;
  }

  function baseForSegment(segMins) {
    if (base == null || !Number.isFinite(Number(base)) || !Number.isFinite(totalMins) || totalMins <= 0) return null;
    return round2(Number(base) * (segMins / totalMins));
  }

  // DP over slots; choose combination that yields the lowest total price among valid combinations.
  const dp = Array(slotCount + 1).fill(Number.POSITIVE_INFINITY);
  const next = Array(slotCount + 1).fill(null);

  dp[slotCount] = 0;

  for (let i = slotCount - 1; i >= 0; i -= 1) {
    for (let len = 1; len <= slotCount - i; len += 1) {
      const segMins = len * slotUnit;

      let rule = ruleWinnerForSegment(i, len);
      let applied = null;

      if (rule) {
        applied = applyRule(baseForSegment(segMins), rule, segMins, slotUnit);
      } else if (len === 1) {
        // per-slot fallback
        const per = rules
          .filter((r) => ruleMatchesLocalInstant(r, slotParts[i]))
          .filter((r) => matchesDuration(slotUnit, r.min_duration_mins, r.max_duration_mins))
          .sort((a, b) => {
            const pa = Number(a.priority || 0);
            const pb = Number(b.priority || 0);
            if (pb !== pa) return pb - pa;
            const sa = specificityScore(a);
            const sb = specificityScore(b);
            if (sb !== sa) return sb - sa;
            return Number(b.id) - Number(a.id);
          })[0] || null;

        rule = per;
        applied = per ? applyRule(baseForSegment(slotUnit), per, slotUnit, slotUnit) : { adjusted: baseForSegment(slotUnit), reason: "no_rule" };
      }

      if (!applied || applied.adjusted == null || !Number.isFinite(Number(applied.adjusted))) continue;

      const cost = Number(applied.adjusted) + dp[i + len];
      if (cost < dp[i]) {
        dp[i] = cost;
        next[i] = { len, rule, applied };
      }
    }
  }

  const adjusted = Number.isFinite(dp[0]) ? round2(dp[0]) : null;

  // Reconstruct chosen segments
  const segments = [];
  let i = 0;
  while (i < slotCount && next[i]) {
    const seg = next[i];
    const segMins = seg.len * slotUnit;
    segments.push({
      start_time: slotStarts[i].toISOString(),
      end_time_exclusive: new Date(slotStarts[i].getTime() + segMins * 60_000).toISOString(),
      slot_count: seg.len,
      duration_minutes: segMins,
      base_price_amount: baseForSegment(segMins),
      rule: seg.rule
        ? {
            id: seg.rule.id,
            name: seg.rule.name,
            price_type: seg.rule.price_type,
            amount: seg.rule.amount,
            time_start: seg.rule.time_start,
            time_end: seg.rule.time_end,
            min_duration_mins: seg.rule.min_duration_mins,
            max_duration_mins: seg.rule.max_duration_mins,
            priority: seg.rule.priority,
          }
        : null,
      adjusted_price_amount: round2(Number(seg.applied.adjusted)),
      reason: seg.applied.reason,
    });
    i += seg.len;
  }

  return {
    base_price_amount: base,
    adjusted_price_amount: adjusted,
    applied_rate_rule_id: null,
    applied_rate_snapshot: {
      computed_at: new Date().toISOString(),
      timezone_used: timezone,
      mode: "dp_segments",
      inputs: {
        tenantId,
        service_id: serviceId || null,
        staff_id: staffId || null,
        resource_id: resourceId || null,
        start_time: start.toISOString(),
        duration_minutes: totalMins,
        service_slot_minutes: slotUnit,
        base_price_amount: base,
      },
      segments,
      result: { adjusted_price_amount: adjusted },
    },
  };
}
module.exports = {
  computeRateForBookingLike,
};
