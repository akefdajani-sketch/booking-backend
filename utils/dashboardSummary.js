// utils/dashboardSummary.js
//
// Main dashboard summary orchestrator.
//
// Used by:
//   - routes/tenantDashboard.js (tenant-scoped auth)
//   - routes/tenants.js (admin-scoped auth)
//
// IMPORTANT:
// - Tenant isolation: EVERY query must be scoped by tenant_id.
// - Revenue is derived from bookings.charge_amount (stored at booking creation).
//
// SIZE-2: This file was previously a 1255-line monolithic function. The
// per-section logic now lives in utils/dashboardSummary/*.js. This file
// is the thin orchestrator that builds shared context once, runs the
// section helpers, and assembles the final response object.
//
// Exported surface kept identical for backward compatibility:
//   getDashboardSummary, parseISODateOnly, computeRange.

const { parseISODateOnly, computeRange } = require("./dashboardHelpers");

const { buildContext }            = require("./dashboardSummary/context");
const { buildKpiSection }         = require("./dashboardSummary/kpi");
const { buildComparisonSection }  = require("./dashboardSummary/comparison");
const { buildUtilizationSection } = require("./dashboardSummary/utilization");
const { buildRulesSection }       = require("./dashboardSummary/rules");
const { buildSeriesSection }      = require("./dashboardSummary/series");
const { appendSmartInsights }     = require("./dashboardSummary/smartInsights");
const { buildTopReturningSection } = require("./dashboardSummary/topReturning");
const { buildStaffSection }       = require("./dashboardSummary/staff");
const { buildResourcesSection }   = require("./dashboardSummary/resources");
const { buildNightlySection }     = require("./dashboardSummary/nightly");
const { buildAlertsSection }      = require("./dashboardSummary/alerts");

async function getDashboardSummary({ tenantId, tenantSlug, mode, dateStr, staffId = null }) {
  // 1. Build shared context (single async setup pass).
  const ctx = await buildContext({ tenantId, tenantSlug, mode, dateStr, staffId });

  // 2. Section helpers. Order matters where one section depends on another:
  //    kpi → utilization (needs bookedMinutes)
  //    utilization → resources (needs openMinutesTotal, tenantHourRows)
  //    kpi+util → rules (needs counts + utilizationPct)
  //    series → smartInsights (peak/top derived from series)
  //    everything → alerts
  const kpi   = await buildKpiSection(ctx);
  const cmp   = await buildComparisonSection(ctx);
  const util  = await buildUtilizationSection(ctx, kpi);
  const { rules, insights, attention } = await buildRulesSection(ctx, kpi, util);
  const series = await buildSeriesSection(ctx);
  await appendSmartInsights(ctx, insights, series);
  const { topReturning, topReturningDetailed, customerMixOverTime, atRisk } = await buildTopReturningSection(ctx);
  const staffUtilization = await buildStaffSection(ctx);
  const { byResource, byService, hourlyHeatmap, peakHours, deadZones } = await buildResourcesSection(ctx, util);
  const nightlyKpis = await buildNightlySection(ctx);
  const alerts = buildAlertsSection(ctx, kpi, util, cmp, rules, atRisk);

  // 3. Assemble the final response object — shape matches the legacy
  //    monolithic version 1:1.
  const repeatRate = {
    value: kpi.repeatPct,
    returningCustomers: kpi.returningCustomers,
    activeCustomers: kpi.activeCustomers,
    newCustomers: kpi.newCustomers,
  };

  return {
    ok: true,
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    range: {
      mode: ctx.mode,
      date: ctx.safeDate,
      from: ctx.rangeStart.toISOString(),
      to: ctx.rangeEnd.toISOString(),
    },
    currency_code: ctx.currencyCode,
    kpis: {
      bookings: kpi.confirmedCount,
      pending: kpi.pendingCount,
      cancelled: kpi.cancelledCount,
      revenue_amount: kpi.revenueAmount,
      utilizationPct: util.utilizationPct,
      repeatPct: kpi.repeatPct,
      activeMemberships: kpi.activeMemberships,
      noShowRate: util.noShowRate,
    },
    nightlyKpis,
    targets: {
      mode: ctx.mode,
      elapsedFraction: alerts.elapsedFraction,
      goals: ctx.targetGoals,
      benchmarks: alerts.targetBenchmarks,
    },
    panels: {
      nextBookings: kpi.nextBookings,
      attention,
      rules,
      alerts: alerts.dashboardAlerts,
      insights,
      thresholds: ctx.thresholds,
      customerPulse: {
        activeCustomers: kpi.activeCustomers,
        returningCustomers: kpi.returningCustomers,
        newCustomers: kpi.newCustomers,
        repeatRate,
        summary: {
          totalCustomers: kpi.activeCustomers,
          activeCustomers: kpi.activeCustomers,
          newCustomers: kpi.newCustomers,
          returningCustomers: kpi.returningCustomers,
        },
        topReturning: topReturningDetailed,
        atRisk,
      },
      topReturning,
      atRisk,
    },
    utilization: {
      overall: {
        value: util.utilizationPct,
        booked_minutes: kpi.bookedMinutes,
        available_minutes: util.openMinutesTotal * Math.max(1, ctx.capacityUnits || 1),
      },
      byResource,
      byStaff: staffUtilization,
      byService,
      hourlyHeatmap,
      peaks: {
        peakHours,
        deadZones,
      },
      resourceSupported: ctx.resourceCount > 0,
      staffSupported: ctx.staffCount > 0,
    },
    series: {
      ...series,
      utilization_over_time: hourlyHeatmap,
      customer_mix_over_time: customerMixOverTime,
      staff_utilization: staffUtilization,
      resource_utilization: byResource,
      utilization_by_service: byService,
    },
    meta: {
      compareEnabled: true,
      compareLabel: 'vs previous period',
      customerPulseSupported: true,
      staffUtilizationSupported: ctx.staffCount > 0,
      resourceUtilizationSupported: ctx.resourceCount > 0,
      widgetSupport: {
        bookingsOverTime: true,
        revenueByService: true,
        utilization: true,
        customerPulse: true,
        alerts: Array.isArray(alerts.dashboardAlerts) && alerts.dashboardAlerts.length > 0,
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
    drilldowns: alerts.drilldowns,
  };
}

module.exports = { getDashboardSummary, parseISODateOnly, computeRange };
