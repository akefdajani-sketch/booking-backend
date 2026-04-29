// utils/dashboardSummary/alerts.js
//
// Dashboard alerts engine wrapper. Composes:
//   - drilldowns: deep-link URLs for each KPI tile
//   - target benchmarks: actual-vs-target progress with elapsed-fraction adjustment
//   - alerts: rule-based alert objects from buildDashboardAlerts (utils/buildDashboardAlerts.js)

const { buildDashboardAlerts } = require("../buildDashboardAlerts");
const {
  computePeriodElapsedFraction,
  buildTargetBenchmark,
} = require("../dashboardHelpers");

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @param {object} kpi      buildKpiSection result
 * @param {object} util     buildUtilizationSection result
 * @param {object} cmp      buildComparisonSection result
 * @param {object} resources  buildResourcesSection result (for atRisk count)
 * @param {Array}  rules    rules.js output rules array (filtered for setup rules)
 * @param {Array}  atRisk   topReturning.js output atRisk array
 * @returns {{
 *   drilldowns, targetBenchmarks, dashboardAlerts,
 *   revenueDeltaPct, bookingsDeltaPct, repeatDeltaPct, elapsedFraction,
 * }}
 */
function buildAlertsSection(ctx, kpi, util, cmp, rules, atRisk) {
  const { tenantSlug, mode, safeDate, rangeStart, rangeEnd, thresholds, targetGoals } = ctx;
  const { confirmedCount, pendingCount, cancelledCount, revenueAmount, repeatPct } = kpi;
  const { utilizationPct, noShowRate } = util;
  const { previousConfirmedCount, previousRevenueAmount, previousNoShowRate, previousRepeatPct } = cmp;

  const revenueDeltaPct = previousRevenueAmount > 0
    ? Number((((Number(revenueAmount || 0) - previousRevenueAmount) / previousRevenueAmount) * 100).toFixed(1))
    : 0;
  const bookingsDeltaPct = previousConfirmedCount > 0
    ? Number((((confirmedCount - previousConfirmedCount) / previousConfirmedCount) * 100).toFixed(1))
    : 0;
  const repeatDeltaPct = Number((repeatPct - previousRepeatPct).toFixed(1));

  const elapsedFraction = computePeriodElapsedFraction(rangeStart, rangeEnd, new Date());
  const targetBenchmarks = {
    bookings: buildTargetBenchmark({ actual: confirmedCount,            target: targetGoals.bookings,        elapsedFraction, direction: 'at_least' }),
    revenue:  buildTargetBenchmark({ actual: Number(revenueAmount || 0), target: targetGoals.revenue_amount,  elapsedFraction, direction: 'at_least' }),
    utilization: buildTargetBenchmark({ actual: Number(utilizationPct || 0), target: targetGoals.utilizationPct, elapsedFraction, direction: 'at_least' }),
    repeat:   buildTargetBenchmark({ actual: Number(repeatPct || 0),     target: targetGoals.repeatPct,       elapsedFraction, direction: 'at_least' }),
    noShow:   buildTargetBenchmark({ actual: Number(noShowRate || 0),    target: targetGoals.noShowRateMax,   elapsedFraction, direction: 'at_most'  }),
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
    drilldowns: dashboardDrilldowns,
    targetBenchmarks,
    dashboardAlerts,
    revenueDeltaPct,
    bookingsDeltaPct,
    repeatDeltaPct,
    elapsedFraction,
  };
}

module.exports = { buildAlertsSection };
