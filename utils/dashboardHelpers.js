// utils/dashboardHelpers.js
//
// Private helper functions for dashboardSummary.js.
// Extracted to reduce dashboardSummary.js line count.
// These are NOT meant to be imported directly outside dashboardSummary.js
// (except parseISODateOnly and computeRange, which are re-exported there).
//
// Originally lived in utils/dashboardSummary.js lines 1-381.

const db = require("../db");

const _columnsCache = new Map(); // tableName -> Set(column_name)

async function getExistingColumns(tableName) {
  if (_columnsCache.has(tableName)) return _columnsCache.get(tableName);
  const res = await db.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [tableName]
  );
  const set = new Set((res.rows || []).map((r) => r.column_name));
  _columnsCache.set(tableName, set);
  return set;
}

function firstExisting(colSet, candidates) {
  for (const c of candidates) {
    if (c && colSet.has(c)) return c;
  }
  return null;
}

async function pickCol(tableName, alias, candidates) {
  const cols = await getExistingColumns(tableName);
  const col = firstExisting(cols, candidates);
  return col ? `${alias}.${col}` : null;
}

function parseISODateOnly(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function startOfDayUTC(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function addDays(d, days) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function startOfWeekMondayUTC(day) {
  const x = new Date(day.getTime());
  const dow = x.getUTCDay(); // 0=Sun..6=Sat
  const mondayDelta = (dow + 6) % 7; // days since Monday
  return addDays(x, -mondayDelta);
}

function startOfMonthUTC(day) {
  const x = new Date(day.getTime());
  x.setUTCDate(1);
  return x;
}

async function countTableRows(table, tenantId) {
  const reg = await db.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
  if (!reg.rows?.[0]?.reg) return 0;
  const r = await db.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE tenant_id=$1`, [tenantId]);
  return r.rows?.[0]?.c || 0;
}

async function resolveTenantCurrencyCode(tenantId) {
  const hasCurrency = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tenants' AND column_name='currency_code' LIMIT 1`
  );
  if (hasCurrency.rowCount <= 0) return null;
  const tc = await db.query(`SELECT currency_code FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
  return tc.rows?.[0]?.currency_code || null;
}


async function resolveDashboardThresholds(tenantId) {
  // Thresholds can be overridden per-tenant via tenants.branding.dashboard.thresholds (jsonb).
  // This keeps TD5 "SaaS-safe" without requiring a schema migration.
  const defaults = {
    utilization_low_pct: 20,
    utilization_critical_low_pct: 10,
    utilization_good_pct: 60,
    repeat_good_pct: 50,
    repeat_drop_warn_pct: 10,
    dropoff_warn_pct: 30,
    revenue_drop_warn_pct: 15,
    revenue_drop_critical_pct: 30,
    booking_drop_warn_pct: 15,
    no_show_warn_pct: 10,
    no_show_critical_pct: 18,
    pending_warn_count: 2,
    pending_critical_count: 6,
    cancel_warn_count: 2,
    at_risk_warn_count: 3,
    alert_cooldown_hours: 24,
  };

  try {
    // branding column exists in modern deployments, but still guard for older DBs
    const hasBranding = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='tenants' AND column_name='branding' LIMIT 1`
    );
    if (hasBranding.rowCount <= 0) return defaults;

    const r = await db.query(`SELECT branding FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
    let branding = r.rows?.[0]?.branding;
    if (!branding) return defaults;

    if (typeof branding === "string") {
      try { branding = JSON.parse(branding); } catch { return defaults; }
    }

    const raw =
      (branding && branding.dashboard && branding.dashboard.thresholds) ||
      (branding && branding.dashboard_widgets && branding.dashboard_widgets.alerts_thresholds) ||
      (branding && branding.dashboard_thresholds) ||
      (branding && branding.thresholds && branding.thresholds.dashboard) ||
      null;

    if (!raw || typeof raw !== "object") return defaults;

    const cleaned = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      cleaned[k] = n;
    }

    return { ...defaults, ...cleaned };
  } catch {
    return defaults;
  }
}


async function resolveDashboardTargets(tenantId, mode) {
  const defaults = {
    day: { bookings: null, revenue_amount: null, utilizationPct: null, repeatPct: null, noShowRateMax: null },
    week: { bookings: null, revenue_amount: null, utilizationPct: null, repeatPct: null, noShowRateMax: null },
    month: { bookings: null, revenue_amount: null, utilizationPct: null, repeatPct: null, noShowRateMax: null },
  };
  try {
    const hasBranding = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='tenants' AND column_name='branding' LIMIT 1`
    );
    if (hasBranding.rowCount <= 0) return defaults[mode] || defaults.day;
    const r = await db.query(`SELECT branding FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
    let branding = r.rows?.[0]?.branding;
    if (!branding) return defaults[mode] || defaults.day;
    if (typeof branding === 'string') {
      try { branding = JSON.parse(branding); } catch { return defaults[mode] || defaults.day; }
    }
    const rawTargets =
      (branding && branding.dashboard_widgets && branding.dashboard_widgets.targets) ||
      (branding && branding.dashboard && branding.dashboard.targets) ||
      null;
    if (!rawTargets || typeof rawTargets !== 'object') return defaults[mode] || defaults.day;
    const raw = rawTargets?.[mode] && typeof rawTargets[mode] === 'object' ? rawTargets[mode] : {};
    const cleaned = {};
    for (const key of ['bookings', 'revenue_amount', 'utilizationPct', 'repeatPct', 'noShowRateMax']) {
      const value = raw[key];
      if (value == null || value === '') {
        cleaned[key] = null;
        continue;
      }
      const n = Number(value);
      cleaned[key] = Number.isFinite(n) ? n : null;
    }
    return { ...defaults[mode], ...cleaned };
  } catch {
    return defaults[mode] || defaults.day;
  }
}

function computePeriodElapsedFraction(rangeStart, rangeEnd, now = new Date()) {
  const start = rangeStart instanceof Date ? rangeStart.getTime() : new Date(rangeStart).getTime();
  const end = rangeEnd instanceof Date ? rangeEnd.getTime() : new Date(rangeEnd).getTime();
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;
  if (current <= start) return 0;
  if (current >= end) return 1;
  return Number(((current - start) / (end - start)).toFixed(4));
}

function buildTargetBenchmark({ actual, target, elapsedFraction = 1, direction = 'at_least' }) {
  const safeActual = Number(actual);
  const safeTarget = Number(target);
  if (!Number.isFinite(safeActual) || !Number.isFinite(safeTarget) || safeTarget <= 0) {
    return {
      target: Number.isFinite(safeTarget) ? safeTarget : null,
      actual: Number.isFinite(safeActual) ? safeActual : null,
      progressPct: null,
      pacePct: null,
      paceTarget: null,
      status: 'no_target',
      remaining: null,
      aheadBehind: null,
      direction,
    };
  }
  const fraction = Math.max(0, Math.min(1, Number.isFinite(elapsedFraction) ? elapsedFraction : 1));
  const paceTarget = safeTarget * fraction;
  if (direction === 'at_most') {
    const progressPct = Math.max(0, Math.min(100, Math.round((safeTarget / Math.max(safeActual || 0.0001, 0.0001)) * 100)));
    return {
      target: safeTarget,
      actual: safeActual,
      progressPct,
      pacePct: null,
      paceTarget,
      status: safeActual <= safeTarget ? 'on_track' : safeActual <= safeTarget * 1.15 ? 'behind' : 'critical',
      remaining: Math.max(0, safeTarget - safeActual),
      aheadBehind: safeTarget - safeActual,
      direction,
    };
  }
  const progressPct = Math.max(0, Math.round((safeActual / safeTarget) * 100));
  const pacePct = paceTarget > 0 ? Math.round((safeActual / paceTarget) * 100) : null;
  let status = 'on_track';
  if (fraction >= 1) {
    status = safeActual >= safeTarget ? 'ahead' : 'behind';
  } else if (pacePct != null) {
    if (pacePct >= 102) status = 'ahead';
    else if (pacePct >= 95) status = 'on_track';
    else if (pacePct >= 80) status = 'behind';
    else status = 'critical';
  }
  return {
    target: safeTarget,
    actual: safeActual,
    progressPct,
    pacePct,
    paceTarget,
    status,
    remaining: Math.max(0, safeTarget - safeActual),
    aheadBehind: safeActual - safeTarget,
    direction,
  };
}


async function tenantHasWorkingHours(tenantId) {
  // Many deployments store working hours as JSON in tenants.working_hours
  const hasWH = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenants' AND column_name='working_hours' LIMIT 1`
  );
  if (hasWH.rowCount <= 0) return null; // unknown
  const r = await db.query(`SELECT working_hours FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
  const wh = r.rows?.[0]?.working_hours;
  if (!wh) return false;
  try {
    // Accept both object and JSON string
    const obj = typeof wh === "string" ? JSON.parse(wh) : wh;
    return obj && typeof obj === "object" && Object.keys(obj).length > 0;
  } catch {
    return true; // non-empty but unparsable: treat as set to avoid false positives
  }
}

async function countServicesRequiring(tenantId) {
  // Returns counts for requires_staff / requires_resource if those columns exist
  const cols = await getExistingColumns("services");
  const hasReqStaff = cols.has("requires_staff");
  const hasReqRes = cols.has("requires_resource");
  if (!hasReqStaff && !hasReqRes) {
    return { staffRequiredServices: 0, resourceRequiredServices: 0 };
  }
  const sel = [
    hasReqStaff ? "COUNT(*) FILTER (WHERE requires_staff=true)::int AS staff_required" : "0::int AS staff_required",
    hasReqRes ? "COUNT(*) FILTER (WHERE requires_resource=true)::int AS resource_required" : "0::int AS resource_required",
  ].join(", ");
  const q = await db.query(
    `SELECT ${sel} FROM services WHERE tenant_id=$1`,
    [tenantId]
  );
  return {
    staffRequiredServices: q.rows?.[0]?.staff_required || 0,
    resourceRequiredServices: q.rows?.[0]?.resource_required || 0,
  };
}
function computeRange(mode, dateStr) {
  const anchorDay = startOfDayUTC(dateStr);
  let rangeStart = anchorDay;
  let rangeEnd = addDays(anchorDay, 1);
  if (mode === "week") {
    rangeStart = startOfWeekMondayUTC(anchorDay);
    rangeEnd = addDays(rangeStart, 7);
  } else if (mode === "month") {
    rangeStart = startOfMonthUTC(anchorDay);
    const nextMonth = new Date(rangeStart.getTime());
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    rangeEnd = nextMonth;
  }
  return { rangeStart, rangeEnd };
}

function parseMinutesFromTime(value) {
  const s = String(value || "").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [hh, mm] = s.split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

function getDayOpenSegments(hourRows, dow) {
  return (hourRows || [])
    .filter((r) => Number(r.day_of_week) === dow && r.is_closed !== true)
    .map((r) => {
      const startMin = parseMinutesFromTime(r.open_time);
      let endMin = parseMinutesFromTime(r.close_time);
      if (startMin == null || endMin == null) return null;
      if (endMin <= startMin) endMin += 24 * 60;
      return { startMin, endMin };
    })
    .filter(Boolean);
}

function buildBucketStarts(mode, rangeStart, rangeEnd) {
  const buckets = [];
  const cursor = new Date(rangeStart.getTime());
  while (cursor.getTime() < rangeEnd.getTime()) {
    buckets.push(new Date(cursor.getTime()));
    if (mode === "day") cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return buckets;
}

function bucketLabel(mode, bucketDate) {
  if (mode === "day") return `${String(bucketDate.getUTCHours()).padStart(2, "0")}:00`;
  return bucketDate.toISOString().slice(0, 10);
}

function computeOpenMinutesForBucket(hourRows, mode, bucketDate) {
  const dow = bucketDate.getUTCDay();
  const segments = getDayOpenSegments(hourRows, dow);
  if (!segments.length) return 0;
  if (mode === "day") {
    const bucketStart = bucketDate.getUTCHours() * 60;
    const bucketEnd = bucketStart + 60;
    return segments.reduce((sum, seg) => sum + overlapMinutes(bucketStart, bucketEnd, seg.startMin, seg.endMin), 0);
  }
  return segments.reduce((sum, seg) => sum + Math.max(0, seg.endMin - seg.startMin), 0);
}

function roundPct(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}

module.exports = {
  getExistingColumns,
  firstExisting,
  pickCol,
  parseISODateOnly,
  startOfDayUTC,
  addDays,
  startOfWeekMondayUTC,
  startOfMonthUTC,
  countTableRows,
  resolveTenantCurrencyCode,
  resolveDashboardThresholds,
  resolveDashboardTargets,
  computePeriodElapsedFraction,
  buildTargetBenchmark,
  tenantHasWorkingHours,
  countServicesRequiring,
  computeRange,
  parseMinutesFromTime,
  overlapMinutes,
  getDayOpenSegments,
  buildBucketStarts,
  bucketLabel,
  computeOpenMinutesForBucket,
  roundPct
};
