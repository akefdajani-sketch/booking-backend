// utils/dashboardSummary/rules.js
//
// PR-TD4: Rules + Insights cards for the dashboard.
//
// Rules    = actionable alerts with optional CTA deep links.
//            Show what's broken/needed and where to go fix it.
// Insights = lightweight derived facts to help operators decide quickly.
//            Read-only signals: repeat rate, utilization, conversion, etc.
//
// Also surfaces a small "attention" array for the Hero strip (not the
// rules list) — pending bookings + underused capacity callouts.

const {
  countServicesRequiring,
  countTableRows,
  tenantHasWorkingHours,
} = require("../dashboardHelpers");

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @param {object} kpi   buildKpiSection result
 * @param {object} util  buildUtilizationSection result
 */
async function buildRulesSection(ctx, kpi, util) {
  const { tenantId, tenantSlug, mode, thresholds, staffCount, resourceCount } = ctx;
  const { pendingCount, cancelledCount, totalRequests, conversionPct, dropoffPct, repeatPct, confirmedCount } = kpi;
  const { utilizationPct } = util;

  const attention = [];
  if (pendingCount >= (thresholds.pending_warn_count || 1)) {
    attention.push({ title: "Pending bookings", value: `${pendingCount} need confirmation`, tone: "warn" });
  }
  if (utilizationPct != null && utilizationPct < (thresholds.utilization_low_pct || 20)) {
    attention.push({ title: "Underused capacity", value: `Utilization under ${(thresholds.utilization_low_pct || 20)}%`, tone: "neutral" });
  }

  const rules = [];
  const insights = [];

  // ─── Config health rules ────────────────────────────────────────────────
  // staffCount and resourceCount come from ctx (already counted in buildContext).
  const servicesCount = await countTableRows("services", tenantId);

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

  if (reqCounts.resourceRequiredServices > 0 && resourceCount === 0) {
    rules.push({
      id: "cfg_resources_missing",
      title: "Resources required but none added",
      value: `${reqCounts.resourceRequiredServices} service(s) require resources — add resources to prevent overbooking.`,
      tone: "warn",
      cta_label: "Add resources",
      cta_href: `/owner/${tenantSlug}?tab=setup&pill=resources`,
    });
  }

  // ─── Operational rules ──────────────────────────────────────────────────
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
      value: `${cancelledCount} booking(s) cancelled in this ${mode}.`,
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

  // ─── Insights (non-actionable, just helpful signals) ────────────────────
  if (repeatPct >= (thresholds.repeat_good_pct || 50)) {
    insights.push({ id: "ins_repeat", title: "Repeat rate", value: `${repeatPct}% returning`, tone: "good" });
  } else {
    insights.push({ id: "ins_repeat", title: "Repeat rate", value: `${repeatPct}% returning`, tone: "neutral" });
  }

  if (utilizationPct != null) {
    const tone = utilizationPct >= (thresholds.utilization_good_pct || 60)
      ? "good"
      : utilizationPct < (thresholds.utilization_low_pct || 20)
      ? "warn"
      : "neutral";
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

  return { rules, insights, attention };
}

module.exports = { buildRulesSection };
