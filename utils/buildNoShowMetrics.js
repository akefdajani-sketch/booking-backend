function safePercent(numerator, denominator) {
  if (!denominator || denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function inferNoShow(booking) {
  if (!booking || typeof booking !== 'object') return false;
  if (booking.no_show === true) return true;
  const status = String(booking.status || '').toLowerCase();
  return status === 'no_show' || status === 'noshow' || status === 'completed_absent';
}

function inferEligible(booking) {
  if (!booking || typeof booking !== 'object') return false;
  const status = String(booking.status || '').toLowerCase();
  if (booking.cancelled_at || booking.canceled_at) return false;
  return ['confirmed', 'checked_in', 'completed', 'no_show', 'noshow', 'completed_absent'].includes(status);
}

function summarize(bookings) {
  const list = Array.isArray(bookings) ? bookings : [];
  const eligible = list.filter(inferEligible);
  const noShows = eligible.filter(inferNoShow);
  return {
    count: noShows.length,
    eligible: eligible.length,
    value: safePercent(noShows.length, eligible.length),
  };
}

function buildNoShowMetrics({ bookingsCurrent, bookingsCompare } = {}) {
  const current = summarize(bookingsCurrent);
  const compare = summarize(bookingsCompare);
  const delta = Number((current.value - compare.value).toFixed(1));

  return {
    value: current.value,
    unit: 'percent',
    count: current.count,
    eligible: current.eligible,
    compareValue: compare.value,
    compareCount: compare.count,
    delta,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    supported: true,
  };
}

module.exports = {
  buildNoShowMetrics,
};
