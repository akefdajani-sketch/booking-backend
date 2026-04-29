// utils/dashboardSummary/kpi.js
//
// Core KPI counts (confirmed/pending/cancelled, revenue, booked minutes),
// next 5 bookings preview, and customer pulse (active/new/returning).
//
// These are the most important queries — the dashboard's KPI row depends
// on them. Don't wrap in try/catch except for the customer-memberships
// table existence check (some older envs lack the table).

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @returns {Promise<{
 *   confirmedCount, pendingCount, cancelledCount, bookedMinutes, revenueAmount,
 *   nextBookings, activeCustomers, newCustomers, returningCustomers, repeatPct,
 *   activeMemberships,
 *   totalRequests, conversionPct, dropoffPct,
 * }>}
 */
async function buildKpiSection(ctx) {
  const { db, tenantId, startCol, staffClause, rangeStart, rangeEnd, revenueSelect } = ctx;

  // Core counters
  const kpi = await db.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_count,
      ${revenueSelect}
      COALESCE(SUM(duration_minutes) FILTER (WHERE status='confirmed'), 0)::int AS booked_minutes
    FROM bookings b
    WHERE b.tenant_id=$1
      ${staffClause}
      AND ${startCol} >= $2
      AND ${startCol} < $3
    `,
    [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
  );

  const confirmedCount = kpi.rows?.[0]?.confirmed_count || 0;
  const pendingCount = kpi.rows?.[0]?.pending_count || 0;
  const cancelledCount = kpi.rows?.[0]?.cancelled_count || 0;
  const bookedMinutes = kpi.rows?.[0]?.booked_minutes || 0;
  const revenueAmount = kpi.rows?.[0]?.revenue_amount != null ? String(kpi.rows[0].revenue_amount) : "0";

  // Next 5 bookings (upcoming pipeline preview)
  const next = await db.query(
    `
    SELECT b.id,
           ${startCol} AS start_time,
           COALESCE(b.customer_name,'') AS customer_name,
           COALESCE(s.name,'') AS service_name,
           b.status
    FROM bookings b
    LEFT JOIN services s ON s.id=b.service_id
    WHERE b.tenant_id=$1
      ${staffClause}
      AND ${startCol} >= NOW()
      AND b.status IN ('confirmed','pending')
    ORDER BY ${startCol} ASC
    LIMIT 5
    `,
    [tenantId]
  );

  const nextBookings = (next.rows || []).map((r) => {
    const status = String(r.status || "").toLowerCase();
    return {
      id: String(r.id),
      start_time: r.start_time,
      customer_name: String(r.customer_name || "").trim() || "Customer",
      service_name: String(r.service_name || "").trim() || "Service",
      status: status === "pending" ? "pending" : status === "cancelled" ? "cancelled" : "confirmed",
    };
  });

  // Customer pulse — active / new / returning
  const pulse = await db.query(
    `
    WITH first_seen AS (
      SELECT customer_id, MIN(${startCol}) AS first_booking_at, COUNT(*)::int AS lifetime_bookings
      FROM bookings b
      WHERE b.tenant_id=$1
        ${staffClause}
        AND b.customer_id IS NOT NULL
      GROUP BY customer_id
    ), in_range AS (
      SELECT DISTINCT b.customer_id
      FROM bookings b
      WHERE b.tenant_id=$1
        ${staffClause}
        AND ${startCol} >= $2
        AND ${startCol} < $3
        AND b.customer_id IS NOT NULL
    )
    SELECT
      COALESCE(COUNT(*),0)::int AS active_customers,
      COALESCE(COUNT(*) FILTER (WHERE fs.first_booking_at >= $2 AND fs.first_booking_at < $3),0)::int AS new_customers,
      COALESCE(COUNT(*) FILTER (WHERE fs.first_booking_at < $2),0)::int AS returning_customers
    FROM in_range r
    JOIN first_seen fs ON fs.customer_id = r.customer_id
    `,
    [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
  );

  const activeCustomers = pulse.rows?.[0]?.active_customers || 0;
  const newCustomers = pulse.rows?.[0]?.new_customers || 0;
  const returningCustomers = pulse.rows?.[0]?.returning_customers || 0;
  const repeatPct = activeCustomers > 0 ? Math.round((returningCustomers / activeCustomers) * 100) : 0;

  // Conversion pipeline
  const totalRequests = confirmedCount + pendingCount + cancelledCount;
  const conversionPct = totalRequests > 0 ? Math.round((confirmedCount / totalRequests) * 100) : null;
  const dropoffPct = totalRequests > 0 ? Math.max(0, 100 - conversionPct) : null;

  // Active memberships (best-effort; table might not exist in older envs)
  let activeMemberships = 0;
  try {
    const memReg = await db.query(`SELECT to_regclass('public.customer_memberships') AS reg`);
    if (memReg.rows?.[0]?.reg) {
      const m = await db.query(
        `
        SELECT COUNT(*)::int AS c
        FROM customer_memberships
        WHERE tenant_id=$1
          AND status='active'
          AND (end_at IS NULL OR end_at > NOW())
        `,
        [tenantId]
      );
      activeMemberships = m.rows?.[0]?.c || 0;
    }
  } catch {}

  return {
    confirmedCount,
    pendingCount,
    cancelledCount,
    bookedMinutes,
    revenueAmount,
    nextBookings,
    activeCustomers,
    newCustomers,
    returningCustomers,
    repeatPct,
    activeMemberships,
    totalRequests,
    conversionPct,
    dropoffPct,
  };
}

module.exports = { buildKpiSection };
