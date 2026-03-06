const DEFAULT_THRESHOLDS = {
  lowUtilizationPct: 20,
  revenueDropPct: -15,
  bookingDropPct: -15,
  repeatDropPct: -10,
  noShowWarnPct: 10,
};

function pctDelta(metric) {
  return Number(metric?.deltaPercent ?? metric?.delta ?? 0);
}

function buildDashboardAlerts(metrics = {}, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const alerts = [];

  if (Number(metrics?.utilization?.value ?? 0) < t.lowUtilizationPct) {
    alerts.push({
      id: 'low_utilization',
      severity: 'warning',
      title: 'Underused capacity',
      body: `Utilization is below ${t.lowUtilizationPct}%. Consider a promo, bundles, or adjusting hours.`,
      ctaLabel: 'Open marketing',
      ctaAction: 'open_marketing',
      active: true,
      metricValue: Number(metrics?.utilization?.value ?? 0),
      thresholdValue: t.lowUtilizationPct,
    });
  }

  if (pctDelta(metrics?.revenue) <= t.revenueDropPct) {
    alerts.push({
      id: 'revenue_drop',
      severity: 'warning',
      title: 'Revenue is down',
      body: 'Revenue has dropped versus the compare period.',
      ctaLabel: 'Open rates',
      ctaAction: 'open_rates',
      active: true,
      metricValue: pctDelta(metrics?.revenue),
      thresholdValue: t.revenueDropPct,
    });
  }

  if (Number(metrics?.noShow?.value ?? 0) > t.noShowWarnPct) {
    alerts.push({
      id: 'high_no_show_rate',
      severity: 'warning',
      title: 'High no-show rate',
      body: `No-show rate is above ${t.noShowWarnPct}%. Consider reminders or confirmation flows.`,
      ctaLabel: 'Open bookings',
      ctaAction: 'view_bookings',
      active: true,
      metricValue: Number(metrics?.noShow?.value ?? 0),
      thresholdValue: t.noShowWarnPct,
    });
  }

  return alerts;
}

module.exports = {
  buildDashboardAlerts,
  DEFAULT_THRESHOLDS,
};
