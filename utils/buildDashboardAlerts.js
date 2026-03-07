const DEFAULT_THRESHOLDS = {
  lowUtilizationPct: 20,
  veryLowUtilizationPct: 10,
  revenueDropPct: -15,
  revenueCriticalDropPct: -30,
  bookingDropPct: -15,
  repeatDropPct: -10,
  noShowWarnPct: 10,
  noShowCriticalPct: 18,
  pendingWarnCount: 2,
  pendingCriticalCount: 6,
  cancelledWarnCount: 2,
  atRiskWarnCount: 3,
  cooldownHours: 24,
};

function pctDelta(metric) {
  return Number(metric?.deltaPercent ?? metric?.delta ?? 0);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function uniqById(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const id = String(item?.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function mkAlert(partial) {
  const severityRank = { info: 1, warning: 2, critical: 3 };
  const severity = partial?.severity || 'info';
  return {
    active: true,
    category: partial?.category || 'ops',
    severity,
    severityRank: severityRank[severity] || 1,
    why: partial?.why || '',
    reason: partial?.reason || partial?.body || '',
    cooldownHours: num(partial?.cooldownHours, DEFAULT_THRESHOLDS.cooldownHours),
    suppressed: false,
    ...partial,
  };
}

function buildDashboardAlerts(metrics = {}, thresholds = {}, options = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const alerts = [];
  const drilldowns = options?.drilldowns || {};
  const setupRules = Array.isArray(options?.setupRules) ? options.setupRules : [];

  const utilizationValue = num(metrics?.utilization?.value, null);
  if (utilizationValue != null && utilizationValue < t.veryLowUtilizationPct) {
    alerts.push(mkAlert({
      id: 'capacity_critical',
      severity: 'critical',
      title: 'Capacity is critically underused',
      body: `Utilization is ${utilizationValue}%, well below the ${t.veryLowUtilizationPct}% critical floor.`,
      why: 'Idle capacity usually means lost revenue and weak schedule density.',
      ctaLabel: 'Open utilization',
      ctaAction: 'open_utilization',
      href: drilldowns?.utilization?.href || drilldowns?.bookings?.href,
      metricValue: utilizationValue,
      thresholdValue: t.veryLowUtilizationPct,
    }));
  } else if (utilizationValue != null && utilizationValue < t.lowUtilizationPct) {
    alerts.push(mkAlert({
      id: 'capacity_low',
      severity: 'warning',
      title: 'Underused capacity',
      body: `Utilization is ${utilizationValue}%, below the ${t.lowUtilizationPct}% target floor.`,
      why: 'This is usually the earliest sign that hours, bundles, or promotions need adjustment.',
      ctaLabel: 'Open utilization',
      ctaAction: 'open_utilization',
      href: drilldowns?.utilization?.href || drilldowns?.bookings?.href,
      metricValue: utilizationValue,
      thresholdValue: t.lowUtilizationPct,
    }));
  }

  const revenueDelta = pctDelta(metrics?.revenue);
  if (revenueDelta <= t.revenueCriticalDropPct) {
    alerts.push(mkAlert({
      id: 'revenue_critical_drop',
      severity: 'critical',
      title: 'Revenue has dropped sharply',
      body: `Revenue is down ${Math.abs(revenueDelta).toFixed(1)}% versus the compare period.`,
      why: 'A sharp revenue decline normally needs action on rates, promos, or booking conversion.',
      ctaLabel: 'Open revenue',
      ctaAction: 'open_revenue',
      href: drilldowns?.revenue?.href || drilldowns?.bookings?.href,
      metricValue: revenueDelta,
      thresholdValue: t.revenueCriticalDropPct,
    }));
  } else if (revenueDelta <= t.revenueDropPct) {
    alerts.push(mkAlert({
      id: 'revenue_drop',
      severity: 'warning',
      title: 'Revenue is down',
      body: `Revenue is down ${Math.abs(revenueDelta).toFixed(1)}% versus the compare period.`,
      why: 'This can come from weaker demand, weaker conversion, or a lower-value booking mix.',
      ctaLabel: 'Open revenue',
      ctaAction: 'open_revenue',
      href: drilldowns?.revenue?.href || drilldowns?.bookings?.href,
      metricValue: revenueDelta,
      thresholdValue: t.revenueDropPct,
    }));
  }

  const bookingsDelta = pctDelta(metrics?.bookings);
  if (bookingsDelta <= t.bookingDropPct) {
    alerts.push(mkAlert({
      id: 'booking_drop',
      severity: 'warning',
      title: 'Bookings are down',
      body: `Confirmed bookings are down ${Math.abs(bookingsDelta).toFixed(1)}% versus the compare period.`,
      why: 'Volume drops usually hit both utilization and revenue if they continue.',
      ctaLabel: 'Open bookings',
      ctaAction: 'view_bookings',
      href: drilldowns?.bookings?.href,
      metricValue: bookingsDelta,
      thresholdValue: t.bookingDropPct,
    }));
  }

  const repeatDelta = pctDelta(metrics?.repeat);
  if (repeatDelta <= t.repeatDropPct) {
    alerts.push(mkAlert({
      id: 'repeat_drop',
      severity: 'warning',
      title: 'Repeat-customer rate is down',
      body: `Repeat rate is down ${Math.abs(repeatDelta).toFixed(1)} points versus the compare period.`,
      why: 'A falling repeat rate can signal weaker retention even before revenue clearly drops.',
      ctaLabel: 'Open customers',
      ctaAction: 'open_customers',
      href: drilldowns?.repeatCustomers?.href || drilldowns?.customerPulse?.href,
      metricValue: repeatDelta,
      thresholdValue: t.repeatDropPct,
    }));
  }

  const noShowRate = num(metrics?.noShow?.value, null);
  if (noShowRate != null && noShowRate >= t.noShowCriticalPct) {
    alerts.push(mkAlert({
      id: 'high_no_show_rate_critical',
      severity: 'critical',
      title: 'No-show rate is critical',
      body: `No-show rate is ${noShowRate.toFixed(1)}%, above the ${t.noShowCriticalPct}% critical line.`,
      why: 'High no-shows waste capacity and distort demand signals.',
      ctaLabel: 'Open no-shows',
      ctaAction: 'view_no_shows',
      href: drilldowns?.noShow?.href || drilldowns?.bookings?.href,
      metricValue: noShowRate,
      thresholdValue: t.noShowCriticalPct,
    }));
  } else if (noShowRate != null && noShowRate >= t.noShowWarnPct) {
    alerts.push(mkAlert({
      id: 'high_no_show_rate',
      severity: 'warning',
      title: 'High no-show rate',
      body: `No-show rate is ${noShowRate.toFixed(1)}%, above the ${t.noShowWarnPct}% warning line.`,
      why: 'Reminder flows or stronger confirmations can usually reduce this quickly.',
      ctaLabel: 'Open no-shows',
      ctaAction: 'view_no_shows',
      href: drilldowns?.noShow?.href || drilldowns?.bookings?.href,
      metricValue: noShowRate,
      thresholdValue: t.noShowWarnPct,
    }));
  }

  const pendingCount = num(metrics?.pending?.value, 0);
  if (pendingCount >= t.pendingCriticalCount) {
    alerts.push(mkAlert({
      id: 'pending_backlog_critical',
      severity: 'critical',
      title: 'Pending backlog is high',
      body: `${pendingCount} bookings still need review or confirmation.`,
      why: 'Pending backlogs can lead to slow response times and lost conversions.',
      ctaLabel: 'Review bookings',
      ctaAction: 'view_bookings',
      href: drilldowns?.bookings?.href,
      metricValue: pendingCount,
      thresholdValue: t.pendingCriticalCount,
    }));
  } else if (pendingCount >= t.pendingWarnCount) {
    alerts.push(mkAlert({
      id: 'pending_backlog',
      severity: 'warning',
      title: 'Pending bookings need review',
      body: `${pendingCount} bookings are still pending.`,
      why: 'Fast follow-up keeps the booking flow feeling reliable.',
      ctaLabel: 'Review bookings',
      ctaAction: 'view_bookings',
      href: drilldowns?.bookings?.href,
      metricValue: pendingCount,
      thresholdValue: t.pendingWarnCount,
    }));
  }

  const cancelledCount = num(metrics?.cancelled?.value, 0);
  if (cancelledCount >= t.cancelledWarnCount) {
    alerts.push(mkAlert({
      id: 'cancellation_spike',
      severity: 'warning',
      title: 'Cancellations are elevated',
      body: `${cancelledCount} cancellations were recorded in this range.`,
      why: 'This can indicate pricing friction, poor slot fit, or reminder problems.',
      ctaLabel: 'Open bookings',
      ctaAction: 'view_bookings',
      href: drilldowns?.bookings?.href,
      metricValue: cancelledCount,
      thresholdValue: t.cancelledWarnCount,
    }));
  }

  const atRiskCount = num(metrics?.atRisk?.value, 0);
  if (atRiskCount >= t.atRiskWarnCount) {
    alerts.push(mkAlert({
      id: 'retention_risk',
      severity: 'warning',
      title: 'Repeat customers are going quiet',
      body: `${atRiskCount} repeat customers appear at risk right now.`,
      why: 'A small rescue campaign can often bring back repeat customers before they churn.',
      ctaLabel: 'Open customers',
      ctaAction: 'open_customers',
      href: drilldowns?.repeatCustomers?.href || drilldowns?.customerPulse?.href,
      metricValue: atRiskCount,
      thresholdValue: t.atRiskWarnCount,
    }));
  }

  for (const rule of setupRules) {
    alerts.push(mkAlert({
      id: `setup_${String(rule?.id || rule?.title || 'issue')}`,
      severity: 'warning',
      category: 'setup',
      title: String(rule?.title || 'Setup issue'),
      body: String(rule?.value || ''),
      why: 'Setup gaps usually distort availability, bookings, or routing until they are fixed.',
      ctaLabel: rule?.cta_label || 'Open setup',
      ctaAction: 'open_setup',
      href: rule?.cta_href || drilldowns?.alerts?.href,
    }));
  }

  return uniqById(alerts)
    .sort((a, b) => (b.severityRank - a.severityRank) || String(a.title).localeCompare(String(b.title)));
}

module.exports = {
  buildDashboardAlerts,
  DEFAULT_THRESHOLDS,
};
