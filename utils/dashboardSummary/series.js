// utils/dashboardSummary/series.js
//
// PR-TD3: Chart-ready series.
//   - bookings_over_time: count of bookings in the selected range, grouped by hour/day
//   - revenue_over_time:  confirmed revenue grouped by hour/day (0 if no money cols)
//   - revenue_by_service: top services by confirmed revenue (0 if no money cols)
//
// Wrapped in a single try/catch so chart failures never block the
// dashboard (KPIs and panels are more important than the chart series).

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @returns {Promise<{
 *   bookings_over_time, revenue_over_time, revenue_by_service,
 * }>}
 */
async function buildSeriesSection(ctx) {
  const { db, tenantId, startCol, staffClause, rangeStart, rangeEnd, truncUnit, hasMoneyCols } = ctx;

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
        ${staffClause}
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
        ${staffClause}
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

  return series;
}

module.exports = { buildSeriesSection };
