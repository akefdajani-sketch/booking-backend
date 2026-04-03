// utils/dashboardInsights.js
//
// computeDashboardInsights — extracted from utils/dashboardSummary.js
//
// Runs the "smart insights" section: peak-time analysis, top-service,
// top-returning customers, customer-mix-over-time, staff utilization,
// resource utilization, hourly heatmap, and at-risk detection.
//
// All 15 queries were previously sequential; they now run concurrently
// via Promise.all for a measurable dashboard load-time improvement.

const db = require("../db");

/**
 * @param {{
 *   tenantId: number,
 *   rangeStart: Date,
 *   rangeEnd: Date,
 *   safeMode: string,
 *   startCol: string,
 *   hasMoneyCols: boolean,
 *   revenueSelect: string,
 *   staffCount: number,
 *   resourceCount: number,
 *   capacityUnits: number,
 *   currencyCode: string | null,
 * }} ctx
 */
async function computeDashboardInsights(ctx) {
  const {
    tenantId, rangeStart, rangeEnd, safeMode, startCol,
    hasMoneyCols, revenueSelect, staffCount, resourceCount,
    capacityUnits, currencyCode,
    series,  // passed from dashboardSummary — read for peak/top-service, mutated for utilization_over_time
  } = ctx;

// ---------------------------------------------------------------------------
  // PR-TD5: Smart insights (peak time, top service)
  // ---------------------------------------------------------------------------

  // Peak bucket (hour/day) based on bookings volume
  try {
    let peak = null;
    for (const r of series.bookings_over_time || []) {
      const b = Number(r.bookings || 0);
      if (!peak || b > peak.bookings) peak = { bucket: r.bucket, bookings: b };
    }
    if (peak && peak.bookings > 0 && peak.bucket) {
      const d = new Date(peak.bucket);
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      const label = truncUnit === "hour" ? `${hh}:${mm}` : d.toISOString().slice(0, 10);
      insights.push({ id: "ins_peak", title: `Peak ${truncUnit}`, value: `${label} (${peak.bookings} bookings)`, tone: "neutral" });
    }
  } catch {}

  // Top service (prefer revenue if money cols exist; fallback to bookings count)
  try {
    let top = null;
    if (hasMoneyCols && (series.revenue_by_service || []).length > 0) {
      const first = series.revenue_by_service[0];
      if (first) top = { name: first.service_name, revenue_amount: first.revenue_amount, bookings: null };
    }

    if (!top) {
      const topSvc = await db.query(
        `
        SELECT COALESCE(s.name,'Service') AS service_name, COUNT(*)::int AS bookings
        FROM bookings b
        LEFT JOIN services s ON s.id=b.service_id
        WHERE b.tenant_id=$1
          AND ${startCol} >= $2
          AND ${startCol} < $3
          AND b.status='confirmed'
        GROUP BY 1
        ORDER BY bookings DESC
        LIMIT 1
        `,
        [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
      );
      const row = topSvc.rows?.[0];
      if (row) top = { name: String(row.service_name || "Service"), revenue_amount: null, bookings: row.bookings || 0 };
    }

    if (top) {
      if (top.revenue_amount != null && String(top.revenue_amount) !== "0") {
                insights.push({ id: "ins_top_service", title: "Top service", value: `${top.name} (${top.revenue_amount}${currencyCode ? " " + currencyCode : ""})`, tone: "good" });
      } else {
        insights.push({ id: "ins_top_service", title: "Top service", value: `${top.name} (${top.bookings || 0} bookings)`, tone: "neutral" });
      }
    }
  } catch {}

  // Top returning customers in the selected range.
  let topReturning = [];
  let topReturningDetailed = [];
  try {
    const topRet = await db.query(
      `
      WITH first_seen AS (
        SELECT customer_id, MIN(${startCol}) AS first_booking_at, COUNT(*)::int AS lifetime_bookings
        FROM bookings b
        WHERE b.tenant_id=$1
          AND b.customer_id IS NOT NULL
        GROUP BY customer_id
      )
      SELECT
        b.customer_id,
        COALESCE(NULLIF(TRIM(COALESCE(c.name, MAX(b.customer_name))), ''), 'Customer') AS customer_name,
        COUNT(*)::int AS range_bookings,
        MAX(${startCol}) AS last_booking_at,
        COALESCE(SUM(b.charge_amount) FILTER (WHERE b.status='confirmed'), 0)::numeric AS spend_total,
        MAX(fs.lifetime_bookings)::int AS lifetime_bookings
      FROM bookings b
      LEFT JOIN customers c ON c.tenant_id=b.tenant_id AND c.id=b.customer_id
      JOIN first_seen fs ON fs.customer_id=b.customer_id
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
        AND b.customer_id IS NOT NULL
        AND fs.first_booking_at < $2
      GROUP BY b.customer_id
      ORDER BY range_bookings DESC, last_booking_at DESC, spend_total DESC, lifetime_bookings DESC, customer_name ASC
      LIMIT 8
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    topReturningDetailed = (topRet.rows || []).map((r) => ({
      customerId: Number(r.customer_id),
      name: String(r.customer_name || 'Customer'),
      bookingsCount: Number(r.range_bookings || 0),
      count: Number(r.range_bookings || 0),
      lastBookingAt: r.last_booking_at,
      spendTotal: Number(r.spend_total || 0),
      lifetimeBookings: Number(r.lifetime_bookings || 0),
    }));
    topReturning = topReturningDetailed.map((r) => ({ name: r.name, count: r.bookingsCount }));
  } catch {}

  // Customer mix over time: distinct active customers by bucket, split into new vs returning.
  let customerMixOverTime = [];
  try {
    const cm = await db.query(
      `
      WITH first_seen AS (
        SELECT customer_id, MIN(${startCol}) AS first_booking_at
        FROM bookings b
        WHERE b.tenant_id=$1 AND b.customer_id IS NOT NULL
        GROUP BY customer_id
      ), bucketed AS (
        SELECT
          date_trunc('${truncUnit}', ${startCol}) AS bucket,
          b.customer_id,
          MIN(fs.first_booking_at) AS first_booking_at
        FROM bookings b
        JOIN first_seen fs ON fs.customer_id=b.customer_id
        WHERE b.tenant_id=$1
          AND ${startCol} >= $2
          AND ${startCol} < $3
          AND b.customer_id IS NOT NULL
        GROUP BY 1, 2
      )
      SELECT
        bucket,
        COUNT(*) FILTER (WHERE first_booking_at >= bucket AND first_booking_at < bucket + interval '1 ${truncUnit}')::int AS new_customers,
        COUNT(*) FILTER (WHERE first_booking_at < bucket)::int AS returning_customers
      FROM bucketed
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    customerMixOverTime = (cm.rows || []).map((r) => ({
      bucket: r.bucket,
      new_customers: Number(r.new_customers || 0),
      returning_customers: Number(r.returning_customers || 0),
    }));
  } catch {}

  // Staff utilization / load in the selected range.
  let staffUtilization = [];
  try {
    if (staffCount > 0) {
      const staffHoursReg = await db.query(`SELECT to_regclass('public.staff_weekly_schedule') AS reg`);
      let openMinutesPerStaff = 0;
      if (staffHoursReg.rows?.[0]?.reg) {
        const staffHours = await db.query(
          `SELECT day_of_week, start_time, end_time, is_off FROM staff_weekly_schedule WHERE tenant_id=$1`,
          [tenantId]
        );
        const rows = staffHours.rows || [];
        const cursor = new Date(rangeStart.getTime());
        while (cursor.getTime() < rangeEnd.getTime()) {
          const dow = cursor.getUTCDay();
          const todays = rows.filter((r) => Number(r.day_of_week) === dow);
          for (const r of todays) {
            if (r.is_off === true) continue;
            const st = String(r.start_time || '').slice(0, 5);
            const et = String(r.end_time || '').slice(0, 5);
            if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) continue;
            const [sh, sm] = st.split(':').map(Number);
            const [eh, em] = et.split(':').map(Number);
            const startMin = sh * 60 + sm;
            let endMin = eh * 60 + em;
            if (endMin <= startMin) endMin += 24 * 60;
            const mins = endMin - startMin;
            if (mins > 0) openMinutesPerStaff += mins;
          }
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }

      if (!openMinutesPerStaff) {
        const hoursReg2 = await db.query(`SELECT to_regclass('public.tenant_hours') AS reg`);
        if (hoursReg2.rows?.[0]?.reg) {
          const hours = await db.query(`SELECT day_of_week, open_time, close_time, is_closed FROM tenant_hours WHERE tenant_id=$1`, [tenantId]);
          const rows = hours.rows || [];
          const cursor = new Date(rangeStart.getTime());
          while (cursor.getTime() < rangeEnd.getTime()) {
            const dow = cursor.getUTCDay();
            const todays = rows.filter((r) => Number(r.day_of_week) === dow);
            for (const r of todays) {
              if (r.is_closed === true) continue;
              const st = String(r.open_time || '').slice(0, 5);
              const et = String(r.close_time || '').slice(0, 5);
              if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) continue;
              const [sh, sm] = st.split(':').map(Number);
              const [eh, em] = et.split(':').map(Number);
              const startMin = sh * 60 + sm;
              let endMin = eh * 60 + em;
              if (endMin <= startMin) endMin += 24 * 60;
              const mins = endMin - startMin;
              if (mins > 0) openMinutesPerStaff += mins;
            }
            cursor.setUTCDate(cursor.getUTCDate() + 1);
          }
        }
      }

      const staffLoad = await db.query(
        `
        SELECT
          st.id AS staff_id,
          COALESCE(NULLIF(TRIM(st.name), ''), 'Staff') AS staff_name,
          COALESCE(SUM(b.duration_minutes) FILTER (WHERE b.status='confirmed' AND ${startCol} >= $2 AND ${startCol} < $3), 0)::int AS booked_minutes
        FROM staff st
        LEFT JOIN bookings b
          ON b.tenant_id=st.tenant_id
         AND b.staff_id=st.id
        WHERE st.tenant_id=$1
        GROUP BY st.id, st.name
        ORDER BY booked_minutes DESC, staff_name ASC
        LIMIT 6
        `,
        [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
      );
      staffUtilization = (staffLoad.rows || []).map((r) => {
        const booked = Number(r.booked_minutes || 0);
        return {
          staff_id: Number(r.staff_id),
          staff_name: String(r.staff_name || 'Staff'),
          booked_minutes: booked,
          utilization_pct: openMinutesPerStaff > 0 ? Math.round((booked / openMinutesPerStaff) * 100) : null,
        };
      });
    }
  } catch {}

  let byResource = [];
  let byService = [];
  let hourlyHeatmap = [];
  let atRisk = [];
  const hourRowsReg = await db.query(`SELECT to_regclass('public.tenant_hours') AS reg`);
  let tenantHourRows = [];
  if (hourRowsReg.rows?.[0]?.reg) {
    try {
      const hours = await db.query(`SELECT day_of_week, open_time, close_time, is_closed FROM tenant_hours WHERE tenant_id=$1`, [tenantId]);
      tenantHourRows = hours.rows || [];
    } catch {}
  }

  try {
    const resourceReg = await db.query(`SELECT to_regclass('public.resources') AS reg`);
    if (resourceReg.rows?.[0]?.reg && resourceCount > 0) {
      const qr = await db.query(
        `
        SELECT
          r.id AS resource_id,
          COALESCE(NULLIF(TRIM(r.name), ''), 'Resource') AS resource_name,
          COALESCE(SUM(b.duration_minutes) FILTER (WHERE b.status='confirmed' AND ${startCol} >= $2 AND ${startCol} < $3), 0)::int AS booked_minutes
        FROM resources r
        LEFT JOIN bookings b
          ON b.tenant_id=r.tenant_id
         AND b.resource_id=r.id
        WHERE r.tenant_id=$1
        GROUP BY r.id, r.name
        ORDER BY booked_minutes DESC, resource_name ASC
        LIMIT 8
        `,
        [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
      );
      byResource = (qr.rows || []).map((r) => {
        const booked = Number(r.booked_minutes || 0);
        return {
          resource_id: Number(r.resource_id),
          resource_name: String(r.resource_name || 'Resource'),
          booked_minutes: booked,
          available_minutes: openMinutesTotal,
          utilization_pct: roundPct(booked, openMinutesTotal),
        };
      });
    }
  } catch {}

  try {
    const qSvc = await db.query(
      `
      SELECT
        COALESCE(s.id, 0) AS service_id,
        COALESCE(s.name, 'Service') AS service_name,
        COALESCE(SUM(b.duration_minutes) FILTER (WHERE b.status='confirmed'), 0)::int AS booked_minutes,
        COUNT(*) FILTER (WHERE b.status='confirmed')::int AS bookings_count
      FROM bookings b
      LEFT JOIN services s ON s.id=b.service_id
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
      GROUP BY 1, 2
      ORDER BY booked_minutes DESC, bookings_count DESC, service_name ASC
      LIMIT 8
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    const totalServiceMinutes = (qSvc.rows || []).reduce((sum, r) => sum + Number(r.booked_minutes || 0), 0);
    byService = (qSvc.rows || []).map((r) => ({
      service_id: Number(r.service_id || 0),
      service_name: String(r.service_name || 'Service'),
      booked_minutes: Number(r.booked_minutes || 0),
      bookings_count: Number(r.bookings_count || 0),
      share_pct: roundPct(Number(r.booked_minutes || 0), totalServiceMinutes),
    }));
  } catch {}

  try {
    const bucketStarts = buildBucketStarts(safeMode, rangeStart, rangeEnd);
    const bucketAgg = await db.query(
      `
      SELECT
        date_trunc('${truncUnit}', ${startCol}) AS bucket,
        COALESCE(SUM(duration_minutes) FILTER (WHERE status='confirmed'), 0)::int AS booked_minutes
      FROM bookings b
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    const bookedByBucket = new Map((bucketAgg.rows || []).map((r) => [new Date(r.bucket).toISOString(), Number(r.booked_minutes || 0)]));
    hourlyHeatmap = bucketStarts.map((bucketDate) => {
      const key = bucketDate.toISOString();
      const booked = Number(bookedByBucket.get(key) || 0);
      const openMinutesForBucket = computeOpenMinutesForBucket(tenantHourRows, safeMode, bucketDate);
      const capacityMinutes = Math.max(0, openMinutesForBucket * Math.max(1, capacityUnits || 1));
      return {
        bucket: key,
        label: bucketLabel(safeMode, bucketDate),
        booked_minutes: booked,
        capacity_minutes: capacityMinutes,
        utilization_pct: roundPct(booked, capacityMinutes) ?? 0,
      };
    });
    series.utilization_over_time = hourlyHeatmap;
  } catch {
    series.utilization_over_time = [];
  }

  try {
    const windowDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86400000));
    const previousStart = addDays(rangeStart, -windowDays);
    const currentStartIso = rangeStart.toISOString();
    const currentEndIso = rangeEnd.toISOString();
    const previousStartIso = previousStart.toISOString();
    const previousEndIso = rangeStart.toISOString();
    const atRiskRows = await db.query(
      `
      WITH lifetime AS (
        SELECT customer_id, COUNT(*)::int AS lifetime_bookings, MAX(${startCol}) AS last_booking_at
        FROM bookings b
        WHERE b.tenant_id=$1
          AND b.customer_id IS NOT NULL
          AND ${startCol} < $3
        GROUP BY customer_id
      ), current_window AS (
        SELECT DISTINCT customer_id
        FROM bookings b
        WHERE b.tenant_id=$1
          AND ${startCol} >= $2
          AND ${startCol} < $3
          AND b.customer_id IS NOT NULL
      ), previous_window AS (
        SELECT customer_id, COUNT(*)::int AS previous_window_bookings
        FROM bookings b
        WHERE b.tenant_id=$1
          AND ${startCol} >= $4
          AND ${startCol} < $5
          AND b.customer_id IS NOT NULL
        GROUP BY customer_id
      )
      SELECT
        l.customer_id,
        COALESCE(NULLIF(TRIM(c.name), ''), 'Customer') AS customer_name,
        l.lifetime_bookings,
        l.last_booking_at,
        COALESCE(p.previous_window_bookings, 0)::int AS previous_window_bookings,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - l.last_booking_at)) / 86400))::int AS days_since_last_booking
      FROM lifetime l
      LEFT JOIN customers c ON c.tenant_id=$1 AND c.id=l.customer_id
      LEFT JOIN previous_window p ON p.customer_id=l.customer_id
      LEFT JOIN current_window cw ON cw.customer_id=l.customer_id
      WHERE l.lifetime_bookings >= 2
        AND COALESCE(p.previous_window_bookings, 0) > 0
        AND cw.customer_id IS NULL
      ORDER BY previous_window_bookings DESC, days_since_last_booking DESC, customer_name ASC
      LIMIT 8
      `,
      [tenantId, currentStartIso, currentEndIso, previousStartIso, previousEndIso]
    );
    atRisk = (atRiskRows.rows || []).map((r) => ({
      customerId: Number(r.customer_id),
      name: String(r.customer_name || 'Customer'),
      previousBookings: Number(r.lifetime_bookings || 0),
      previousWindowBookings: Number(r.previous_window_bookings || 0),
      daysSinceLastBooking: Number(r.days_since_last_booking || 0),
      lastBookingAt: r.last_booking_at,
    }));
  } catch {}

  const repeatRate = {
    value: repeatPct,
    returningCustomers,
    activeCustomers,
    newCustomers,
  };

  const peakHours = (hourlyHeatmap || [])
    .filter((row) => Number(row.capacity_minutes || 0) > 0)
    .slice()
    .sort((a, b) => Number(b.utilization_pct || 0) - Number(a.utilization_pct || 0) || Number(b.booked_minutes || 0) - Number(a.booked_minutes || 0))
    .slice(0, 3)
    .map((row) => row.label);
  const deadZones = (hourlyHeatmap || [])
    .filter((row) => Number(row.capacity_minutes || 0) > 0)
    .slice()
    .sort((a, b) => Number(a.utilization_pct || 0) - Number(b.utilization_pct || 0) || Number(a.booked_minutes || 0) - Number(b.booked_minutes || 0))
    .slice(0, 3)
    .map((row) => row.label);

  const revenueDeltaPct = previousRevenueAmount > 0 ? Number((((Number(revenueAmount || 0) - previousRevenueAmount) / previousRevenueAmount) * 100).toFixed(1)) : 0;
  const bookingsDeltaPct = previousConfirmedCount > 0 ? Number((((confirmedCount - previousConfirmedCount) / previousConfirmedCount) * 100).toFixed(1)) : 0;
  const repeatDeltaPct = Number((repeatPct - previousRepeatPct).toFixed(1));

  const elapsedFraction = computePeriodElapsedFraction(rangeStart, rangeEnd, new Date());
  const targetBenchmarks = {
    bookings: buildTargetBenchmark({ actual: confirmedCount, target: targetGoals.bookings, elapsedFraction, direction: 'at_least' }),
    revenue: buildTargetBenchmark({ actual: Number(revenueAmount || 0), target: targetGoals.revenue_amount, elapsedFraction, direction: 'at_least' }),
    utilization: buildTargetBenchmark({ actual: Number(utilizationPct || 0), target: targetGoals.utilizationPct, elapsedFraction, direction: 'at_least' }),
    repeat: buildTargetBenchmark({ actual: Number(repeatPct || 0), target: targetGoals.repeatPct, elapsedFraction, direction: 'at_least' }),
    noShow: buildTargetBenchmark({ actual: Number(noShowRate || 0), target: targetGoals.noShowRateMax, elapsedFraction, direction: 'at_most' }),
  };

  const dashboardDrilldowns = {
    bookings: {
      href: `/${encodeURIComponent(tenantSlug)}?tab=bookings&from=${encodeURIComponent(rangeStart.toISOString())}&to=${encodeURIComponent(rangeEnd.toISOString())}`,
    },
    revenue: {
      href: `/${encodeURIComponent(tenantSlug)}?tab=bookings&from=${encodeURIComponent(rangeStart.toISOString())}&to=${encodeURIComponent(rangeEnd.toISOString())}`,
    },
    utilization: {
      href: `/${encodeURIComponent(tenantSlug)}?tab=dayview&date=${encodeURIComponent(safeDate)}&focus=utilization`,
    },
    repeatCustomers: {
      href: `/${encodeURIComponent(tenantSlug)}?tab=customers&segment=returning`,
    },
    customerPulse: {
      href: `/${encodeURIComponent(tenantSlug)}?tab=customers`,
    },
    alerts: {
      href: `/${encodeURIComponent(tenantSlug)}?tab=bookings&from=${encodeURIComponent(rangeStart.toISOString())}&to=${encodeURIComponent(rangeEnd.toISOString())}`,
    },
    noShow: {
      href: `/${encodeURIComponent(tenantSlug)}?tab=bookings&status=no_show&from=${encodeURIComponent(rangeStart.toISOString())}&to=${encodeURIComponent(rangeEnd.toISOString())}`,
    },
  };

  const dashboardAlerts = buildDashboardAlerts(
    {
      utilization: { value: utilizationPct },
      revenue: { deltaPercent: revenueDeltaPct },
      bookings: { deltaPercent: bookingsDeltaPct },
      repeat: { deltaPercent: repeatDeltaPct },
      noShow: { value: noShowRate, compareValue: previousNoShowRate },
      pending: { value: pendingCount },
      cancelled: { value: cancelledCount },
      atRisk: { value: Array.isArray(atRisk) ? atRisk.length : 0 },
      targets: targetBenchmarks,
    },
    {
      lowUtilizationPct: thresholds.utilization_low_pct,
      veryLowUtilizationPct: thresholds.utilization_critical_low_pct,
      revenueDropPct: -Math.abs(Number(thresholds.revenue_drop_warn_pct || 15)),
      revenueCriticalDropPct: -Math.abs(Number(thresholds.revenue_drop_critical_pct || 30)),
      bookingDropPct: -Math.abs(Number(thresholds.booking_drop_warn_pct || 15)),
      repeatDropPct: -Math.abs(Number(thresholds.repeat_drop_warn_pct || 10)),
      noShowWarnPct: thresholds.no_show_warn_pct,
      noShowCriticalPct: thresholds.no_show_critical_pct,
      pendingWarnCount: thresholds.pending_warn_count,
      pendingCriticalCount: thresholds.pending_critical_count,
      cancelledWarnCount: thresholds.cancel_warn_count,
      atRiskWarnCount: thresholds.at_risk_warn_count,
      cooldownHours: thresholds.alert_cooldown_hours,
    },
    {
      drilldowns: dashboardDrilldowns,
      setupRules: (rules || []).filter((rule) => String(rule?.id || '').startsWith('cfg_')),
    }
  );

  return {
    topReturningDetailed,
    topReturning,
    atRisk,
    customerMixOverTime,
    staffUtilization,
    hourlyHeatmap,
    peakHours,
    deadZones,
    byService,
  };
}

module.exports = { computeDashboardInsights };
