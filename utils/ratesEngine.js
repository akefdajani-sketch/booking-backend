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

function applyRule(basePriceAmount, rule, durationMinutes, serviceSlotMinutes) {
  const base = Number(basePriceAmount);
  if (!Number.isFinite(base)) return { adjusted: null, reason: "missing_base" };
  const amt = Number(rule.amount);
  if (!Number.isFinite(amt)) return { adjusted: round2(base), reason: "invalid_amount" };

  const t = String(rule.price_type || "").toLowerCase();

  if (t === "fixed") {
    // Package rule: when min_duration === max_duration the amount IS the total
    // price for that exact booking length — do NOT multiply by slot count.
    // e.g. "Karaoke 2 Hour" → Fixed 70 JD for exactly 120 min = 70 JD total.
    const minD = rule.min_duration_mins != null ? Number(rule.min_duration_mins) : null;
    const maxD = rule.max_duration_mins != null ? Number(rule.max_duration_mins) : null;
    if (minD != null && maxD != null && minD === maxD && minD > 0) {
      return { adjusted: round2(amt), reason: "fixed_package" };
    }

    // Per-slot fixed rate: scale amount by number of slots selected.
    // e.g. "Peak Hours" Fixed 40 JD per slot × 2 slots = 80 JD.
    const slotUnit = Number(serviceSlotMinutes) || 0;
    const dur      = Number(durationMinutes)    || 0;
    if (slotUnit > 0 && dur > 0 && dur !== slotUnit) {
      return { adjusted: round2(amt * (dur / slotUnit)), reason: "fixed_scaled" };
    }
    return { adjusted: round2(amt), reason: "fixed" };
  }

  // Delta and Multiplier already operate on the duration-scaled base price,
  // so they naturally handle multi-slot bookings correctly.
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
  serviceSlotMinutes,   // service base slot duration; used to scale Fixed rules
}) {
  const base = basePriceAmount == null ? null : round2(basePriceAmount);

  const resolvedSlotMinutes =
    Number(serviceSlotMinutes) > 0 ? Number(serviceSlotMinutes) : Number(durationMinutes);

  const timezone = await loadTenantTimezone(tenantId);
  const rules = await loadRules({ tenantId, serviceId, staffId, resourceId });

  function slotLocalParts(slotStart) {
    return toLocalParts(slotStart, timezone);
  }

  function ruleMatchesLocalInstant(rule, parts) {
    const { dateStr, timeStr, dow } = parts;

    if (Array.isArray(rule.days_of_week) && rule.days_of_week.length) {
      if (!rule.days_of_week.map(Number).includes(dow)) return false;
    }
    if (!isWithinDateRange(dateStr, rule.date_start, rule.date_end)) return false;
    if (!isWithinTimeWindow(timeStr, rule.time_start, rule.time_end)) return false;
    return true;
  }

  function pickWinnerFor(parts, durMins) {
    const matches = rules
      .filter((r) => {
        if (!ruleMatchesLocalInstant(r, parts)) return false;
        if (!matchesDuration(durMins, r.min_duration_mins, r.max_duration_mins)) return false;
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

  const slotUnit =
    Number(resolvedSlotMinutes) > 0 ? Number(resolvedSlotMinutes) : Number(durationMinutes);
  const totalMins = Number(durationMinutes) || 0;
  const slotCount = slotUnit > 0 ? Math.max(1, Math.ceil(totalMins / slotUnit)) : 1;

  const slotStarts = Array.from({ length: slotCount }, (_, i) => new Date(start.getTime() + i * slotUnit * 60_000));
  const slotParts = slotStarts.map(slotLocalParts);

  const signatures = slotParts.map((parts) => {
    const ids = rules
      .filter((r) => ruleMatchesLocalInstant(r, parts))
      .map((r) => Number(r.id))
      .sort((a, b) => a - b);
    return ids.join(",");
  });

  const isSingleUniverse = signatures.every((s) => s === signatures[0]);

  function computeSegment({ fromIdx, toIdx }) {
    const segSlots = toIdx - fromIdx + 1;
    const segDuration = segSlots * slotUnit;

    const segBase =
      base == null || !Number.isFinite(Number(base)) ? null : round2(Number(base) * (segDuration / totalMins));

    const winner =
      rules
        .filter((r) => {
          if (!matchesDuration(segDuration, r.min_duration_mins, r.max_duration_mins)) return false;
          for (let i = fromIdx; i <= toIdx; i += 1) {
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
        })[0] || null;

    if (winner) {
      const applied = applyRule(segBase, winner, segDuration, slotUnit);
      return { winner, applied, segBase, segDuration, segSlots, mode: "segment_rule" };
    }

    let sum = 0;
    const perSlot = [];
    for (let i = fromIdx; i <= toIdx; i += 1) {
      const oneBase = segBase == null ? null : round2(Number(segBase) * (slotUnit / segDuration));
      const oneWinner = pickWinnerFor(slotParts[i], slotUnit);
      const oneApplied = oneWinner
        ? applyRule(oneBase, oneWinner, slotUnit, slotUnit)
        : { adjusted: oneBase, reason: "no_rule" };
      sum += Number(oneApplied.adjusted || 0);
      perSlot.push({
        slot_start: slotStarts[i].toISOString(),
        local_date: slotParts[i].dateStr,
        local_time: slotParts[i].timeStr,
        local_dow: slotParts[i].dow,
        duration_minutes: slotUnit,
        base_price_amount: oneBase,
        rule_id: oneWinner ? oneWinner.id : null,
        rule_name: oneWinner ? oneWinner.name : null,
        adjusted_price_amount: oneApplied.adjusted,
        reason: oneApplied.reason,
      });
    }

    return {
      winner: null,
      applied: { adjusted: round2(sum), reason: "sum_of_slots" },
      segBase,
      segDuration,
      segSlots,
      perSlot,
      mode: "sum_of_slots",
    };
  }

  let winner = null;
  let applied = null;
  let snapshot = null;

  if (isSingleUniverse) {
    const parts = slotParts[0];
    winner = pickWinnerFor(parts, totalMins);

    applied = winner ? applyRule(base, winner, totalMins, slotUnit) : { adjusted: base, reason: "no_rule" };

    snapshot = {
      computed_at: new Date().toISOString(),
      timezone_used: timezone,
      mode: "single_rule",
      inputs: {
        service_id: serviceId || null,
        staff_id: staffId || null,
        resource_id: resourceId || null,
        start_time: start.toISOString(),
        local_date: parts.dateStr,
        local_time: parts.timeStr,
        local_dow: parts.dow,
        duration_minutes: totalMins,
        service_slot_minutes: slotUnit,
        base_price_amount: base,
      },
      rule: winner
        ? {
            id: winner.id,
            name: winner.name,
            service_id: winner.service_id,
            staff_id: winner.staff_id,
            resource_id: winner.resource_id,
            currency_code: winner.currency_code,
            price_type: winner.price_type,
            amount: winner.amount,
            days_of_week: winner.days_of_week,
            time_start: winner.time_start,
            time_end: winner.time_end,
            date_start: winner.date_start,
            date_end: winner.date_end,
            min_duration_mins: winner.min_duration_mins,
            max_duration_mins: winner.max_duration_mins,
            priority: winner.priority,
          }
        : null,
      result: { adjusted_price_amount: applied.adjusted, reason: applied.reason },
    };
  } else {
    const segments = [];
    let fromIdx = 0;
    for (let i = 1; i < slotCount; i += 1) {
      if (signatures[i] !== signatures[i - 1]) {
        segments.push({ fromIdx, toIdx: i - 1 });
        fromIdx = i;
      }
    }
    segments.push({ fromIdx, toIdx: slotCount - 1 });

    const computedSegments = segments.map(computeSegment);
    const totalAdjusted = round2(computedSegments.reduce((acc, s) => acc + Number(s.applied.adjusted || 0), 0));

    applied = { adjusted: totalAdjusted, reason: "segmented_pricing" };

    snapshot = {
      computed_at: new Date().toISOString(),
      timezone_used: timezone,
      mode: "segmented_pricing",
      inputs: {
        service_id: serviceId || null,
        staff_id: staffId || null,
        resource_id: resourceId || null,
        start_time: start.toISOString(),
        duration_minutes: totalMins,
        service_slot_minutes: slotUnit,
        base_price_amount: base,
      },
      segments: computedSegments.map((s, idx) => {
        const segStart = slotStarts[segments[idx].fromIdx];
        const segEnd = new Date(segStart.getTime() + s.segDuration * 60_000);
        return {
          segment_index: idx,
          from_slot_index: segments[idx].fromIdx,
          to_slot_index: segments[idx].toIdx,
          start_time: segStart.toISOString(),
          end_time_exclusive: segEnd.toISOString(),
          duration_minutes: s.segDuration,
          slot_count: s.segSlots,
          base_price_amount: s.segBase,
          mode: s.mode,
          rule: s.winner
            ? {
                id: s.winner.id,
                name: s.winner.name,
                price_type: s.winner.price_type,
                amount: s.winner.amount,
                time_start: s.winner.time_start,
                time_end: s.winner.time_end,
                min_duration_mins: s.winner.min_duration_mins,
                max_duration_mins: s.winner.max_duration_mins,
                priority: s.winner.priority,
              }
            : null,
          adjusted_price_amount: s.applied.adjusted,
          reason: s.applied.reason,
          per_slot: s.perSlot || undefined,
        };
      }),
      result: { adjusted_price_amount: totalAdjusted, reason: "segmented_pricing" },
    };
  }

  return {
    base_price_amount: base,
    adjusted_price_amount: applied.adjusted,
    applied_rate_rule_id: winner ? winner.id : null,
    applied_rate_snapshot: snapshot,
  };
}

module.exports = {
  computeRateForBookingLike,
};
