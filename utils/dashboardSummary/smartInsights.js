// utils/dashboardSummary/smartInsights.js
//
// PR-TD5: Smart insights derived from bookings_over_time and
// revenue_by_service. These are appended to the insights array built by
// rules.js — non-actionable signals to help operators decide quickly.
//
// Two pieces:
//   - Peak bucket (hour/day) by bookings volume
//   - Top service by revenue (or by bookings if no money cols)

/**
 * Append smart insights to an existing insights array.
 *
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @param {Array} insights existing insights array (mutated)
 * @param {object} series  buildSeriesSection result
 */
async function appendSmartInsights(ctx, insights, series) {
  const { db, tenantId, startCol, rangeStart, rangeEnd, truncUnit, hasMoneyCols, currencyCode } = ctx;

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
}

module.exports = { appendSmartInsights };
