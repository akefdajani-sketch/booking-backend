// utils/ratesEngine.js
// Centralized rate rule selection + pricing application.
//
// NOTE: This is intentionally conservative and JS-filtered to reduce SQL complexity.
// Future: move more filtering into SQL once timezone normalization is finalized.

const { pool } = require("../db");
const db = pool;

function round2(n) {
  if (n == null) return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function isWithinDateRange(startDateStr, dateStart, dateEnd) {
  if (!dateStart && !dateEnd) return true;
  if (dateStart && startDateStr < dateStart) return false;
  if (dateEnd && startDateStr > dateEnd) return false;
  return true;
}

function isWithinTimeWindow(startTimeStr, timeStart, timeEnd) {
  // startTimeStr: "HH:MM:SS"
  if (!timeStart && !timeEnd) return true;
  if (timeStart && timeEnd) {
    // If window wraps midnight (e.g. 22:00 -> 02:00), treat as two segments.
    if (timeEnd < timeStart) {
      return startTimeStr >= timeStart || startTimeStr <= timeEnd;
    }
    return startTimeStr >= timeStart && startTimeStr <= timeEnd;
  }
  if (timeStart) return startTimeStr >= timeStart;
  if (timeEnd) return startTimeStr <= timeEnd;
  return true;
}

function matchesDuration(durationMinutes, minDur, maxDur) {
  if (minDur != null && durationMinutes < Number(minDur)) return false;
  if (maxDur != null && durationMinutes > Number(maxDur)) return false;
  return true;
}

function specificityScore(rule) {
  // More specific wins when priorities tie.
  let s = 0;
  if (rule.service_id != null) s += 10;
  if (rule.staff_id != null) s += 5;
  if (rule.resource_id != null) s += 3;
  return s;
}

function applyRule(basePriceAmount, rule) {
  const base = Number(basePriceAmount);
  if (!Number.isFinite(base)) return { adjusted: null, reason: "missing_base" };
  const amt = Number(rule.amount);
  if (!Number.isFinite(amt)) return { adjusted: round2(base), reason: "invalid_amount" };

  const t = String(rule.price_type || "").toLowerCase();
  if (t === "fixed") return { adjusted: round2(amt), reason: "fixed" };
  if (t === "delta") return { adjusted: round2(base + amt), reason: "delta" };
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
      AND (service_id IS NULL OR service_id = $2)
      AND (staff_id IS NULL OR staff_id = $3)
      AND (resource_id IS NULL OR resource_id = $4)
    `,
    [tenantId, serviceId || null, staffId || null, resourceId || null]
  );
  return rows;
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
  const startIso = start.toISOString();
  const dateStr = startIso.slice(0, 10);
  const timeStr = startIso.slice(11, 19);
  const dow = start.getUTCDay();

  const rules = await loadRules({ tenantId, serviceId, staffId, resourceId });

  const matches = rules
    .filter((r) => {
      // DOW
      if (Array.isArray(r.days_of_week) && r.days_of_week.length) {
        if (!r.days_of_week.map(Number).includes(dow)) return false;
      }
      // Date
      if (!isWithinDateRange(dateStr, r.date_start, r.date_end)) return false;
      // Time
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

  const winner = matches[0] || null;
  const applied = winner ? applyRule(base, winner) : { adjusted: base, reason: "no_rule" };

  const snapshot = {
    computed_at: new Date().toISOString(),
    inputs: {
      service_id: serviceId || null,
      staff_id: staffId || null,
      resource_id: resourceId || null,
      start_time: startIso,
      duration_minutes: durationMinutes,
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
    result: {
      adjusted_price_amount: applied.adjusted,
      reason: applied.reason,
    },
  };

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
