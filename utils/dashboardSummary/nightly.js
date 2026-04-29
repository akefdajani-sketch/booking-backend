// utils/dashboardSummary/nightly.js
//
// PR-RENTAL-DASH: Nightly occupancy & revenue by unit.
//
// Only runs when the tenant has nightly-mode resources AND
// rental_mode_enabled=TRUE.
//
// v2 §3.1 fix: prevent leakage onto time-slot tenants. Two issues both
// gated:
//   1. Was counting ALL tenant resources as total_units (Birdie Golf bays
//      were leaking in). Now restricts the COUNT to nightly rental_types.
//   2. Belt-and-braces: also gate on tenants.rental_mode_enabled, so even
//      if a time-slot tenant has stray rental_type rows, the widget stays
//      hidden until the tenant explicitly opts in.
//
// Non-fatal — wrapped in try/catch so a schema gap never breaks the
// dashboard.

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @returns {Promise<null|{
 *   total_units, range_nights, booked_nights, occupancy_pct,
 *   nightly_revenue, by_unit,
 * }>}
 */
async function buildNightlySection(ctx) {
  const { db, tenantId, rangeStart, rangeEnd } = ctx;

  let nightlyKpis = null;
  try {
    // First: tenant must have rental mode explicitly enabled.
    const rentalCheck = await db.query(
      `SELECT COALESCE(rental_mode_enabled, FALSE) AS enabled
       FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const rentalEnabled = Boolean(rentalCheck.rows?.[0]?.enabled);

    // Then: tenant must have at least one nightly-typed resource.
    const nightlyCheck = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM resources
       WHERE tenant_id=$1
         AND rental_type IN ('short_term','long_term','flexible')`,
      [tenantId]
    );
    const hasNightlyUnits = Number(nightlyCheck.rows?.[0]?.cnt || 0) > 0;

    if (!rentalEnabled || !hasNightlyUnits) {
      return null;
    }

    // Total nightly units (NOT total tenant resources — that was the leak).
    const unitCountRes = await db.query(
      `SELECT COUNT(*)::int AS total_units FROM resources
       WHERE tenant_id=$1
         AND rental_type IN ('short_term','long_term','flexible')`,
      [tenantId]
    );
    const totalUnits = Number(unitCountRes.rows?.[0]?.total_units || 0);

    const rangeNights = Math.max(1, Math.round(
      (rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)
    ));
    const totalPossibleNights = totalUnits * rangeNights;

    // Count booked nights in range (using checkin_date/checkout_date overlap)
    const bookedNightsRes = await db.query(
      `SELECT
         COALESCE(SUM(
           LEAST(checkout_date, $3::date) - GREATEST(checkin_date, $2::date)
         ), 0)::int AS booked_nights,
         COALESCE(SUM(charge_amount) FILTER (WHERE status='confirmed'), 0)::numeric AS nightly_revenue
       FROM bookings
       WHERE tenant_id=$1
         AND deleted_at IS NULL
         AND checkin_date IS NOT NULL
         AND checkout_date IS NOT NULL
         AND status IN ('confirmed','checked_in','completed')
         AND checkin_date < $3::date
         AND checkout_date > $2::date`,
      [tenantId, rangeStart.toISOString().slice(0, 10), rangeEnd.toISOString().slice(0, 10)]
    );
    const bookedNights = Number(bookedNightsRes.rows?.[0]?.booked_nights || 0);
    const nightlyRevenue = String(bookedNightsRes.rows?.[0]?.nightly_revenue || '0');
    const occupancyPct = totalPossibleNights > 0
      ? Math.round((bookedNights / totalPossibleNights) * 100)
      : 0;

    // Revenue & occupancy by unit
    const byUnitRes = await db.query(
      `SELECT
         r.id AS resource_id,
         r.name AS resource_name,
         r.building_name,
         COUNT(b.id) FILTER (WHERE b.status IN ('confirmed','checked_in','completed'))::int AS bookings_count,
         COALESCE(SUM(
           LEAST(b.checkout_date, $3::date) - GREATEST(b.checkin_date, $2::date)
         ) FILTER (WHERE b.status IN ('confirmed','checked_in','completed')), 0)::int AS booked_nights,
         COALESCE(SUM(b.charge_amount) FILTER (WHERE b.status='confirmed'), 0)::numeric AS revenue
       FROM resources r
       LEFT JOIN bookings b
         ON b.resource_id = r.id
        AND b.tenant_id = r.tenant_id
        AND b.deleted_at IS NULL
        AND b.checkin_date IS NOT NULL
        AND b.checkin_date < $3::date
        AND b.checkout_date > $2::date
       WHERE r.tenant_id=$1
       GROUP BY r.id, r.name, r.building_name
       ORDER BY booked_nights DESC, r.name ASC`,
      [tenantId, rangeStart.toISOString().slice(0, 10), rangeEnd.toISOString().slice(0, 10)]
    );

    const byUnit = byUnitRes.rows.map((r) => ({
      resource_id: r.resource_id,
      resource_name: r.resource_name,
      building_name: r.building_name || null,
      bookings_count: Number(r.bookings_count || 0),
      booked_nights: Number(r.booked_nights || 0),
      occupancy_pct: rangeNights > 0
        ? Math.round((Number(r.booked_nights || 0) / rangeNights) * 100)
        : 0,
      revenue: String(r.revenue || '0'),
    }));

    nightlyKpis = {
      total_units: totalUnits,
      range_nights: rangeNights,
      booked_nights: bookedNights,
      occupancy_pct: occupancyPct,
      nightly_revenue: nightlyRevenue,
      by_unit: byUnit,
    };
  } catch (nightlyErr) {
    // Non-fatal — nightly dashboard requires migration 024 columns
    console.warn('dashboardSummary: nightly occupancy skipped', nightlyErr?.message);
  }

  return nightlyKpis;
}

module.exports = { buildNightlySection };
