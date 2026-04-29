// utils/dashboardSummary/topReturning.js
//
// Customer-relationship sections:
//   - topReturning:        top 8 returning customers (range bookings + spend)
//   - customerMixOverTime: new vs returning customers per bucket
//   - atRisk:              customers active in previous window but absent now
//
// Each is independently try/catched — a failure in one doesn't block
// the others.

const { addDays } = require("../dashboardHelpers");

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @returns {Promise<{
 *   topReturning, topReturningDetailed, customerMixOverTime, atRisk,
 * }>}
 */
async function buildTopReturningSection(ctx) {
  const { db, tenantId, startCol, staffClause, rangeStart, rangeEnd, truncUnit } = ctx;

  // Top returning customers in the selected range.
  let topReturning = [];
  let topReturningDetailed = [];
  try {
    const topRet = await db.query(
      `
      WITH first_seen AS (
        SELECT customer_id, MIN(${startCol}) AS first_booking_at, COUNT(*)::int AS lifetime_bookings
        FROM bookings b
        WHERE b.tenant_id=$1
          AND b.customer_id IS NOT NULL
        GROUP BY customer_id
      )
      SELECT
        b.customer_id,
        COALESCE(NULLIF(TRIM(COALESCE(c.name, MAX(b.customer_name))), ''), 'Customer') AS customer_name,
        COUNT(*)::int AS range_bookings,
        MAX(${startCol}) AS last_booking_at,
        COALESCE(SUM(b.charge_amount) FILTER (WHERE b.status='confirmed'), 0)::numeric AS spend_total,
        MAX(fs.lifetime_bookings)::int AS lifetime_bookings
      FROM bookings b
      LEFT JOIN customers c ON c.tenant_id=b.tenant_id AND c.id=b.customer_id
      JOIN first_seen fs ON fs.customer_id=b.customer_id
      WHERE b.tenant_id=$1
        ${staffClause}
        AND ${startCol} >= $2
        AND ${startCol} < $3
        AND b.customer_id IS NOT NULL
        AND fs.first_booking_at < $2
      GROUP BY b.customer_id
      ORDER BY range_bookings DESC, last_booking_at DESC, spend_total DESC, lifetime_bookings DESC, customer_name ASC
      LIMIT 8
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    topReturningDetailed = (topRet.rows || []).map((r) => ({
      customerId: Number(r.customer_id),
      name: String(r.customer_name || 'Customer'),
      bookingsCount: Number(r.range_bookings || 0),
      count: Number(r.range_bookings || 0),
      lastBookingAt: r.last_booking_at,
      spendTotal: Number(r.spend_total || 0),
      lifetimeBookings: Number(r.lifetime_bookings || 0),
    }));
    topReturning = topReturningDetailed.map((r) => ({ name: r.name, count: r.bookingsCount }));
  } catch {}

  // Customer mix over time: distinct active customers by bucket, split into new vs returning.
  let customerMixOverTime = [];
  try {
    const cm = await db.query(
      `
      WITH first_seen AS (
        SELECT customer_id, MIN(${startCol}) AS first_booking_at
        FROM bookings b
        WHERE b.tenant_id=$1 AND b.customer_id IS NOT NULL
        GROUP BY customer_id
      ), bucketed AS (
        SELECT
          date_trunc('${truncUnit}', ${startCol}) AS bucket,
          b.customer_id,
          MIN(fs.first_booking_at) AS first_booking_at
        FROM bookings b
        JOIN first_seen fs ON fs.customer_id=b.customer_id
        WHERE b.tenant_id=$1
          AND ${startCol} >= $2
          AND ${startCol} < $3
          AND b.customer_id IS NOT NULL
        GROUP BY 1, 2
      )
      SELECT
        bucket,
        COUNT(*) FILTER (WHERE first_booking_at >= bucket AND first_booking_at < bucket + interval '1 ${truncUnit}')::int AS new_customers,
        COUNT(*) FILTER (WHERE first_booking_at < bucket)::int AS returning_customers
      FROM bucketed
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    customerMixOverTime = (cm.rows || []).map((r) => ({
      bucket: r.bucket,
      new_customers: Number(r.new_customers || 0),
      returning_customers: Number(r.returning_customers || 0),
    }));
  } catch {}

  // At-risk: customers active in the previous window but not the current one.
  let atRisk = [];
  try {
    const windowDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86400000));
    const previousStart = addDays(rangeStart, -windowDays);
    const currentStartIso = rangeStart.toISOString();
    const currentEndIso = rangeEnd.toISOString();
    const previousStartIso = previousStart.toISOString();
    const previousEndIso = rangeStart.toISOString();
    const atRiskRows = await db.query(
      `
      WITH lifetime AS (
        SELECT customer_id, COUNT(*)::int AS lifetime_bookings, MAX(${startCol}) AS last_booking_at
        FROM bookings b
        WHERE b.tenant_id=$1
          AND b.customer_id IS NOT NULL
          AND ${startCol} < $3
        GROUP BY customer_id
      ), current_window AS (
        SELECT DISTINCT customer_id
        FROM bookings b
        WHERE b.tenant_id=$1
          AND ${startCol} >= $2
          AND ${startCol} < $3
          AND b.customer_id IS NOT NULL
      ), previous_window AS (
        SELECT customer_id, COUNT(*)::int AS previous_window_bookings
        FROM bookings b
        WHERE b.tenant_id=$1
          AND ${startCol} >= $4
          AND ${startCol} < $5
          AND b.customer_id IS NOT NULL
        GROUP BY customer_id
      )
      SELECT
        l.customer_id,
        COALESCE(NULLIF(TRIM(c.name), ''), 'Customer') AS customer_name,
        l.lifetime_bookings,
        l.last_booking_at,
        COALESCE(p.previous_window_bookings, 0)::int AS previous_window_bookings,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - l.last_booking_at)) / 86400))::int AS days_since_last_booking
      FROM lifetime l
      LEFT JOIN customers c ON c.tenant_id=$1 AND c.id=l.customer_id
      LEFT JOIN previous_window p ON p.customer_id=l.customer_id
      LEFT JOIN current_window cw ON cw.customer_id=l.customer_id
      WHERE l.lifetime_bookings >= 2
        AND COALESCE(p.previous_window_bookings, 0) > 0
        AND cw.customer_id IS NULL
      ORDER BY previous_window_bookings DESC, days_since_last_booking DESC, customer_name ASC
      LIMIT 8
      `,
      [tenantId, currentStartIso, currentEndIso, previousStartIso, previousEndIso]
    );
    atRisk = (atRiskRows.rows || []).map((r) => ({
      customerId: Number(r.customer_id),
      name: String(r.customer_name || 'Customer'),
      previousBookings: Number(r.lifetime_bookings || 0),
      previousWindowBookings: Number(r.previous_window_bookings || 0),
      daysSinceLastBooking: Number(r.days_since_last_booking || 0),
      lastBookingAt: r.last_booking_at,
    }));
  } catch {}

  return {
    topReturning,
    topReturningDetailed,
    customerMixOverTime,
    atRisk,
  };
}

module.exports = { buildTopReturningSection };
