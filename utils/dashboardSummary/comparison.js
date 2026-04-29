// utils/dashboardSummary/comparison.js
//
// Previous-period comparison snapshot for DSH-5 alerts.
// Computes the same window length, shifted backwards in time, so we can
// derive deltas (revenue change, booking change, repeat-rate change,
// no-show change) for the alerts engine.
//
// All queries are best-effort — if comparison fails for any reason the
// dashboard still renders with zeros, no alerts.

const { addDays } = require("../dashboardHelpers");

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @returns {Promise<{
 *   previousConfirmedCount, previousRevenueAmount,
 *   previousNoShowRate, previousRepeatPct,
 *   compareStart, compareEnd,
 * }>}
 */
async function buildComparisonSection(ctx) {
  const { db, tenantId, startCol, staffClause, rangeStart, rangeEnd } = ctx;

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
        ${staffClause}
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
        ${staffClause}
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

  return {
    previousConfirmedCount,
    previousRevenueAmount,
    previousNoShowRate,
    previousRepeatPct,
    compareStart,
    compareEnd,
  };
}

module.exports = { buildComparisonSection };
