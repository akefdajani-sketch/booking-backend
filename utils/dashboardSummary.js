// utils/dashboardSummary.js
//
// Main dashboard summary query.  All helper utilities live in dashboardHelpers.js.
// Used by:
//   - routes/tenantDashboard.js (tenant-scoped auth)
//   - routes/tenants.js (admin-scoped auth)
//
// IMPORTANT:
// - Tenant isolation: EVERY query must be scoped by tenant_id.
// - Revenue is derived from bookings.charge_amount (stored at booking creation).

const db = require("../db");
const { computeDashboardInsights } = require("./dashboardInsights");
const { ensureBookingMoneyColumns, bookingMoneyColsAvailable } = require("./ensureBookingMoneyColumns");
const { buildDashboardAlerts } = require("./buildDashboardAlerts");

const {
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
} = require("./dashboardHelpers");

async function getDashboardSummary({ tenantId, tenantSlug, mode, dateStr }) {
  const hasMoneyCols = await ensureBookingMoneyColumns();

  // bookings start column compatibility (start_time vs start_at vs start_datetime...)
  const startCol = await pickCol("bookings", "b", [
    "start_time",
    "start_at",
    "start_datetime",
    "starts_at",
    "start",
  ]);
  if (!startCol) {
    throw new Error(
      "Dashboard summary cannot run: bookings table has no recognized start time column (expected one of start_time/start_at/start_datetime/starts_at)."
    );
  }

  const safeMode = mode === "week" || mode === "month" ? mode : "day";
  const safeDate = parseISODateOnly(dateStr) || new Date().toISOString().slice(0, 10);

  const { rangeStart, rangeEnd } = computeRange(safeMode, safeDate);

  const revenueSelect = hasMoneyCols ? "COALESCE(SUM(charge_amount) FILTER (WHERE status='confirmed'), 0)::numeric AS revenue_amount," : "0::numeric AS revenue_amount,";

  const kpi = await db.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_count,
      ${revenueSelect}
      COALESCE(SUM(duration_minutes) FILTER (WHERE status='confirmed'), 0)::int AS booked_minutes
    FROM bookings b
    WHERE b.tenant_id=$1
      AND ${startCol} >= $2
      AND ${startCol} < $3
    `,
    [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
  );

  const confirmedCount = kpi.rows?.[0]?.confirmed_count || 0;
  const pendingCount = kpi.rows?.[0]?.pending_count || 0;
  const cancelledCount = kpi.rows?.[0]?.cancelled_count || 0;
  const bookedMinutes = kpi.rows?.[0]?.booked_minutes || 0;
  const revenueAmount = kpi.rows?.[0]?.revenue_amount != null ? String(kpi.rows[0].revenue_amount) : "0";

  const currencyCode = await resolveTenantCurrencyCode(tenantId);
  const thresholds = await resolveDashboardThresholds(tenantId);
  const targetGoals = await resolveDashboardTargets(tenantId, safeMode);


  const next = await db.query(
    `
    SELECT b.id,
           ${startCol} AS start_time,
           COALESCE(b.customer_name,'') AS customer_name,
           COALESCE(s.name,'') AS service_name,
           b.status
    FROM bookings b
    LEFT JOIN services s ON s.id=b.service_id
    WHERE b.tenant_id=$1
      AND ${startCol} >= NOW()
      AND b.status IN ('confirmed','pending')
    ORDER BY ${startCol} ASC
    LIMIT 5
    `,
    [tenantId]
  );

  const pulse = await db.query(
    `
    WITH first_seen AS (
      SELECT customer_id, MIN(${startCol}) AS first_booking_at, COUNT(*)::int AS lifetime_bookings
      FROM bookings b
      WHERE b.tenant_id=$1
        AND b.customer_id IS NOT NULL
      GROUP BY customer_id
    ), in_range AS (
      SELECT DISTINCT b.customer_id
      FROM bookings b
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
        AND b.customer_id IS NOT NULL
    )
    SELECT
      COALESCE(COUNT(*),0)::int AS active_customers,
      COALESCE(COUNT(*) FILTER (WHERE fs.first_booking_at >= $2 AND fs.first_booking_at < $3),0)::int AS new_customers,
      COALESCE(COUNT(*) FILTER (WHERE fs.first_booking_at < $2),0)::int AS returning_customers
    FROM in_range r
    JOIN first_seen fs ON fs.customer_id = r.customer_id
    `,
    [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
  );

  const activeCustomers = pulse.rows?.[0]?.active_customers || 0;
  const newCustomers = pulse.rows?.[0]?.new_customers || 0;
  const returningCustomers = pulse.rows?.[0]?.returning_customers || 0;
  const repeatPct = activeCustomers > 0 ? Math.round((returningCustomers / activeCustomers) * 100) : 0;

  const totalRequests = confirmedCount + pendingCount + cancelledCount;
  const conversionPct = totalRequests > 0 ? Math.round((confirmedCount / totalRequests) * 100) : null;
  const dropoffPct = totalRequests > 0 ? Math.max(0, 100 - conversionPct) : null;

  // Previous-period comparison snapshot for DSH-5 alerts.
  const rangeSpanDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86400000));
  const compareStart = addDays(rangeStart, -rangeSpanDays);
  const compareEnd = rangeStart;
  let previousConfirmedCount = 0;
  let previousRevenueAmount = 0;
  let previousNoShowRate = 0;
  let previousRepeatPct = 0;
  try {
    const prevAgg = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
        COALESCE(SUM(charge_amount) FILTER (WHERE status='confirmed'), 0)::numeric AS revenue_amount,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('confirmed','checked_in','completed','no_show','noshow','completed_absent'))::int AS eligible_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('no_show','noshow','completed_absent'))::int AS no_show_count
      FROM bookings b
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
      `,
      [tenantId, compareStart.toISOString(), compareEnd.toISOString()]
    );
    previousConfirmedCount = Number(prevAgg.rows?.[0]?.confirmed_count || 0);
    previousRevenueAmount = Number(prevAgg.rows?.[0]?.revenue_amount || 0);
    const prevEligible = Number(prevAgg.rows?.[0]?.eligible_count || 0);
    const prevNoShows = Number(prevAgg.rows?.[0]?.no_show_count || 0);
    previousNoShowRate = prevEligible > 0 ? Number(((prevNoShows / prevEligible) * 100).toFixed(1)) : 0;
  } catch {}
  try {
    const prevRepeat = await db.query(
      `
      WITH first_seen AS (
        SELECT customer_id, MIN(${startCol}) AS first_booking_at
        FROM bookings b
        WHERE b.tenant_id=$1
          AND b.customer_id IS NOT NULL
        GROUP BY customer_id
      )
      SELECT
        COUNT(DISTINCT b.customer_id)::int AS active_customers,
        COUNT(DISTINCT b.customer_id) FILTER (WHERE fs.first_booking_at < $2)::int AS returning_customers
      FROM bookings b
      JOIN first_seen fs ON fs.customer_id=b.customer_id
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
        AND b.customer_id IS NOT NULL
      `,
      [tenantId, compareStart.toISOString(), compareEnd.toISOString()]
    );
    const prevActiveCustomers = Number(prevRepeat.rows?.[0]?.active_customers || 0);
    const prevReturningCustomers = Number(prevRepeat.rows?.[0]?.returning_customers || 0);
    previousRepeatPct = prevActiveCustomers > 0 ? Math.round((prevReturningCustomers / prevActiveCustomers) * 100) : 0;
  } catch {}

  // Active memberships (best-effort; table might not exist in older envs)
  let activeMemberships = 0;
  const memReg = await db.query(`SELECT to_regclass('public.customer_memberships') AS reg`);
  if (memReg.rows?.[0]?.reg) {
    const m = await db.query(
      `
      SELECT COUNT(*)::int AS c
      FROM customer_memberships
      WHERE tenant_id=$1
        AND status='active'
        AND (end_at IS NULL OR end_at > NOW())
      `,
      [tenantId]
    );
    activeMemberships = m.rows?.[0]?.c || 0;
  }

  // Utilization: resources first, then staff
  const resourceCount = await countTableRows("resources", tenantId);
  const staffCount = await countTableRows("staff", tenantId);
  const capacityUnits = resourceCount > 0 ? resourceCount : staffCount;

  let utilizationPct = null;
  let openMinutesTotal = 0;
  const hoursReg = await db.query(`SELECT to_regclass('public.tenant_hours') AS reg`);
  if (hoursReg.rows?.[0]?.reg && capacityUnits > 0) {
    // tenant_hours schema in this codebase uses open_time/close_time/is_closed
    // (see routes/tenantHours.js). Older dashboard implementations mistakenly
    // referenced start_time/end_time which do not exist.
    const hours = await db.query(
      `SELECT day_of_week, open_time, close_time, is_closed
       FROM tenant_hours
       WHERE tenant_id=$1`,
      [tenantId]
    );

    const rows = hours.rows || [];
    let openMinutes = 0;

    const cursor = new Date(rangeStart.getTime());
    while (cursor.getTime() < rangeEnd.getTime()) {
      const dow = cursor.getUTCDay();
      const todays = rows.filter((r) => Number(r.day_of_week) === dow);
      for (const r of todays) {
        if (r.is_closed === true) continue;
        const st = String(r.open_time || "").slice(0, 5);
        const et = String(r.close_time || "").slice(0, 5);
        if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) continue;
        const [sh, sm] = st.split(":").map(Number);
        const [eh, em] = et.split(":").map(Number);
        const startMin = sh * 60 + sm;
        let endMin = eh * 60 + em;

        // Support "overnight" schedules and the common pattern where close_time is stored as 00:00
        // to represent "midnight at end of day" (e.g. 10:00 → 00:00 should mean 14 hours, not 0).
        // If end <= start, treat close as next-day.
        if (endMin <= startMin) endMin += 24 * 60;

        const mins = endMin - startMin;
        if (mins > 0) openMinutes += mins;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    openMinutesTotal = openMinutes;
    const capacityMinutes = openMinutes * capacityUnits;
    if (capacityMinutes > 0) utilizationPct = Math.round((bookedMinutes / capacityMinutes) * 100);
  }

  const nextBookings = (next.rows || []).map((r) => {
    const status = String(r.status || "").toLowerCase();
    return {
      id: String(r.id),
      start_time: r.start_time,
      customer_name: String(r.customer_name || "").trim() || "Customer",
      service_name: String(r.service_name || "").trim() || "Service",
      status: status === "pending" ? "pending" : status === "cancelled" ? "cancelled" : "confirmed",
    };
  });

  const eligibleNoShowStatuses = ['confirmed', 'checked_in', 'completed', 'no_show', 'noshow', 'completed_absent'];
  const noShowStatuses = ['no_show', 'noshow', 'completed_absent'];
  let noShowCount = 0;
  let noShowEligibleCount = 0;
  try {
    const noShowAgg = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = ANY($4::text[]))::int AS no_show_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = ANY($5::text[]))::int AS eligible_count
      FROM bookings b
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString(), noShowStatuses, eligibleNoShowStatuses]
    );
    noShowCount = Number(noShowAgg.rows?.[0]?.no_show_count || 0);
    noShowEligibleCount = Number(noShowAgg.rows?.[0]?.eligible_count || 0);
  } catch {}
  const noShowRate = noShowEligibleCount > 0 ? Number(((noShowCount / noShowEligibleCount) * 100).toFixed(1)) : 0;

  const attention = [];
  if (pendingCount >= (thresholds.pending_warn_count || 1)) {
    attention.push({ title: "Pending bookings", value: `${pendingCount} need confirmation`, tone: "warn" });
  }
  if (utilizationPct != null && utilizationPct < (thresholds.utilization_low_pct || 20)) {
    attention.push({ title: "Underused capacity", value: `Utilization under ${(thresholds.utilization_low_pct || 20)}%`, tone: "neutral" });
  }


  // ---------------------------------------------------------------------------
  // PR-TD4: Rules + Insights cards
  //
  // Rules are actionable alerts (with optional CTA deep links).
  // Insights are lightweight derived facts to help operators decide quickly.
  // ---------------------------------------------------------------------------

  const rules = [];
  const insights = [];

  // Config health rules
  // NOTE: staffCount and resourceCount were already computed above for utilization.
  // Avoid redeclaring them here (Render deploy was failing with "Identifier ... has already been declared").
  const servicesCount = await countTableRows("services", tenantId);
  const resourcesCount = resourceCount;

  const whSet = await tenantHasWorkingHours(tenantId);
  if (whSet === false) {
    rules.push({
      id: "cfg_working_hours",
      title: "Working hours not set",
      value: "Set opening/closing hours so availability matches your real schedule.",
      tone: "warn",
      cta_label: "Set hours",
      cta_href: `/owner/${tenantSlug}?tab=setup&pill=hours`,
    });
  }

  if (servicesCount === 0) {
    rules.push({
      id: "cfg_services",
      title: "No services configured",
      value: "Add at least one service so customers can book.",
      tone: "warn",
      cta_label: "Add services",
      cta_href: `/owner/${tenantSlug}?tab=setup&pill=services`,
    });
  }

  const reqCounts = await countServicesRequiring(tenantId);
  if (reqCounts.staffRequiredServices > 0 && staffCount === 0) {
    rules.push({
      id: "cfg_staff_missing",
      title: "Staff required but none added",
      value: `${reqCounts.staffRequiredServices} service(s) require staff — add staff to avoid availability issues.`,
      tone: "warn",
      cta_label: "Add staff",
      cta_href: `/owner/${tenantSlug}?tab=setup&pill=staff`,
    });
  }

  if (reqCounts.resourceRequiredServices > 0 && resourcesCount === 0) {
    rules.push({
      id: "cfg_resources_missing",
      title: "Resources required but none added",
      value: `${reqCounts.resourceRequiredServices} service(s) require resources — add resources to prevent overbooking.`,
      tone: "warn",
      cta_label: "Add resources",
      cta_href: `/owner/${tenantSlug}?tab=setup&pill=resources`,
    });
  }

  // Operational rules
  if (pendingCount >= (thresholds.pending_warn_count || 1)) {
    rules.push({
      id: "ops_pending",
      title: "Pending bookings",
      value: `${pendingCount} booking(s) need confirmation.`,
      tone: "warn",
      cta_label: "Review bookings",
      cta_href: `/owner/${tenantSlug}?tab=bookings`,
    });
  }

  if (cancelledCount >= (thresholds.cancel_warn_count || 1)) {
    rules.push({
      id: "ops_cancelled",
      title: "Cancellations in range",
      value: `${cancelledCount} booking(s) cancelled in this ${safeMode}.`,
      tone: "neutral",
      cta_label: "View bookings",
      cta_href: `/owner/${tenantSlug}?tab=bookings`,
    });
  }

  if (utilizationPct != null && utilizationPct < (thresholds.utilization_low_pct || 20)) {
    rules.push({
      id: "ops_underused",
      title: "Underused capacity",
      value: `Utilization under ${(thresholds.utilization_low_pct || 20)}%. Consider a promo, bundles, or adjusting hours.`,
      tone: "neutral",
      cta_label: "Open marketing",
      cta_href: `/owner/${tenantSlug}?tab=dashboard`,
    });
  }

  if (dropoffPct != null && dropoffPct >= (thresholds.dropoff_warn_pct || 30) && totalRequests >= 5) {
    const dominant = pendingCount >= cancelledCount ? "pending" : "cancelled";
    rules.push({
      id: "ops_dropoff",
      title: "High drop-off in this range",
      value: `${dropoffPct}% of requests are not confirmed (${dominant} is the biggest factor).`,
      tone: "warn",
      cta_label: "Review pipeline",
      cta_href: `/owner/${tenantSlug}?tab=bookings`,
    });
  }

  // Insights (non-actionable, just helpful signals)
  if (repeatPct >= (thresholds.repeat_good_pct || 50)) insights.push({ id: "ins_repeat", title: "Repeat rate", value: `${repeatPct}% returning`, tone: "good" });
  else insights.push({ id: "ins_repeat", title: "Repeat rate", value: `${repeatPct}% returning`, tone: "neutral" });

  if (utilizationPct != null) {
    const tone = utilizationPct >= (thresholds.utilization_good_pct || 60) ? "good" : utilizationPct < (thresholds.utilization_low_pct || 20) ? "warn" : "neutral";
    insights.push({ id: "ins_util", title: "Utilization", value: `${utilizationPct}%`, tone });
  }

  if (confirmedCount > 0) {
    insights.push({ id: "ins_confirmed", title: "Confirmed bookings", value: String(confirmedCount), tone: "neutral" });
  }

  if (conversionPct != null) {
    const goodCut = 100 - (thresholds.dropoff_warn_pct || 30);
    const tone = conversionPct >= goodCut ? "good" : conversionPct < 50 ? "warn" : "neutral";
    insights.push({ id: "ins_conversion", title: "Conversion", value: `${conversionPct}% confirmed`, tone });
  }
  if (dropoffPct != null) {
    const tone = dropoffPct >= (thresholds.dropoff_warn_pct || 30) ? "warn" : "neutral";
    const dominant = pendingCount >= cancelledCount ? "pending" : "cancelled";
    insights.push({ id: "ins_dropoff", title: "Drop-off points", value: `${dropoffPct}% not confirmed (${dominant} is highest)`, tone });
  }


  // ---------------------------------------------------------------------------
  // PR-TD3: Chart-ready series (still lightweight + tenant-safe)
  //
  // - bookings_over_time: count of bookings in the selected range, grouped by hour/day
  // - revenue_over_time: confirmed revenue grouped by hour/day (0 if no money cols)
  // - revenue_by_service: top services by confirmed revenue (0 if no money cols)
  // ---------------------------------------------------------------------------

  const truncUnit = safeMode === "day" ? "hour" : "day";
  const series = {
    bookings_over_time: [],
    revenue_over_time: [],
    revenue_by_service: [],
  };

  try {
    const ts = await db.query(
      `
      SELECT
        date_trunc('${truncUnit}', ${startCol}) AS bucket,
        COUNT(*)::int AS bookings,
        ${hasMoneyCols ? "COALESCE(SUM(charge_amount) FILTER (WHERE status='confirmed'), 0)::numeric" : "0::numeric"} AS revenue
      FROM bookings b
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );

    series.bookings_over_time = (ts.rows || []).map((r) => ({
      bucket: r.bucket,
      bookings: r.bookings,
    }));
    series.revenue_over_time = (ts.rows || []).map((r) => ({
      bucket: r.bucket,
      revenue_amount: String(r.revenue ?? "0"),
    }));

    const svc = await db.query(
      `
      SELECT
        COALESCE(s.name, 'Service') AS service_name,
        ${hasMoneyCols ? "COALESCE(SUM(b.charge_amount) FILTER (WHERE b.status='confirmed'), 0)::numeric" : "0::numeric"} AS revenue
      FROM bookings b
      LEFT JOIN services s ON s.id=b.service_id
      WHERE b.tenant_id=$1
        AND ${startCol} >= $2
        AND ${startCol} < $3
      GROUP BY 1
      ORDER BY revenue DESC
      LIMIT 8
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );

    series.revenue_by_service = (svc.rows || []).map((r) => ({
      service_name: String(r.service_name || "Service"),
      revenue_amount: String(r.revenue ?? "0"),
    }));
  } catch (e) {
    // Never fail the dashboard if charts fail.
    // The KPI + panels are more important than the chart series.
  }

  // ---------------------------------------------------------------------------
  // PR-TD5: Smart insights — delegated to computeDashboardInsights()
  // (extracted to utils/dashboardInsights.js; runs queries concurrently)
  // ---------------------------------------------------------------------------
  const {
    topReturningDetailed,
    topReturning,
    atRisk,
    customerMixOverTime,
    staffUtilization,
    hourlyHeatmap,
    peakHours,
    deadZones,
    byService,
  } = await computeDashboardInsights({
    tenantId, rangeStart, rangeEnd, safeMode, startCol,
    hasMoneyCols, revenueSelect, staffCount, resourceCount,
    capacityUnits, currencyCode,
  });

  return {
    ok: true,
    tenantId,
    tenantSlug,
    range: {
      mode: safeMode,
      date: safeDate,
      from: rangeStart.toISOString(),
      to: rangeEnd.toISOString(),
    },
    currency_code: currencyCode,
    kpis: {
      bookings: confirmedCount,
      pending: pendingCount,
      cancelled: cancelledCount,
      revenue_amount: revenueAmount,
      utilizationPct,
      repeatPct,
      activeMemberships,
      noShowRate,
    },
    targets: {
      mode: safeMode,
      elapsedFraction,
      goals: targetGoals,
      benchmarks: targetBenchmarks,
    },
    panels: {
      nextBookings,
      attention,
      rules,
      alerts: dashboardAlerts,
      insights,
      thresholds,
      customerPulse: {
        activeCustomers,
        returningCustomers,
        newCustomers,
        repeatRate,
        summary: {
          totalCustomers: activeCustomers,
          activeCustomers,
          newCustomers,
          returningCustomers,
        },
        topReturning: topReturningDetailed,
        atRisk,
      },
      topReturning,
      atRisk,
    },
    utilization: {
      overall: {
        value: utilizationPct,
        booked_minutes: bookedMinutes,
        available_minutes: openMinutesTotal * Math.max(1, capacityUnits || 1),
      },
      byResource,
      byStaff: staffUtilization,
      byService,
      hourlyHeatmap,
      peaks: {
        peakHours,
        deadZones,
      },
      resourceSupported: resourceCount > 0,
      staffSupported: staffCount > 0,
    },
    series: {
      ...series,
      customer_mix_over_time: customerMixOverTime,
      staff_utilization: staffUtilization,
      resource_utilization: byResource,
      utilization_by_service: byService,
    },
    meta: {
      compareEnabled: true,
      compareLabel: 'vs previous period',
      customerPulseSupported: true,
      staffUtilizationSupported: staffCount > 0,
      resourceUtilizationSupported: resourceCount > 0,
      widgetSupport: {
        bookingsOverTime: true,
        revenueByService: true,
        utilization: true,
        customerPulse: true,
        alerts: Array.isArray(dashboardAlerts) && dashboardAlerts.length > 0,
        insights: Array.isArray(insights) && insights.length > 0,
      },
      targetSupport: true,
      widgetVisibilityDefaults: {
        bookings_over_time: true,
        revenue_by_service: true,
        utilization: true,
        customer_pulse: true,
        next_up: true,
        customer_pulse_panel: true,
        rules_alerts: true,
        insights: true,
      },
    },
    drilldowns: dashboardDrilldowns,
  };
}

module.exports = { getDashboardSummary, parseISODateOnly, computeRange };

module.exports = { getDashboardSummary, parseISODateOnly, computeRange };
