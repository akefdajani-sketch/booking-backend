// utils/dashboardSummary/nightly.js
//
// PR-RENTAL-DASH:    Nightly occupancy & revenue by unit (TD-5, original).
// PR-RENTAL-DASH-1:  Adds STR-industry KPIs:
//                      - adr                    (Average Daily Rate)
//                      - revpar                 (Revenue Per Available Night)
//                      - cancellation_rate_pct  (replaces No-show for nightly)
//                      - alos                   (Average Length of Stay)
//                      - lead_time_days         (avg days from booking to check-in)
//                      - service_share[]        (Long Term vs Short Term split)
//                      - booking_pace[]         (bookings made per ISO week, last 8w)
//                    All additions strictly additive — original fields unchanged.
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
 *   adr, revpar, cancellation_rate_pct, alos, lead_time_days,
 *   service_share, booking_pace,
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

    const rangeStartStr = rangeStart.toISOString().slice(0, 10);
    const rangeEndStr   = rangeEnd.toISOString().slice(0, 10);

    // ─── Existing aggregate: booked nights + revenue (kept identical) ────────
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
      [tenantId, rangeStartStr, rangeEndStr]
    );
    const bookedNights   = Number(bookedNightsRes.rows?.[0]?.booked_nights   || 0);
    const nightlyRevenue = String(bookedNightsRes.rows?.[0]?.nightly_revenue || '0');
    const occupancyPct   = totalPossibleNights > 0
      ? Math.round((bookedNights / totalPossibleNights) * 100)
      : 0;

    // ─── Existing: revenue & occupancy by unit (kept identical) ──────────────
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
      [tenantId, rangeStartStr, rangeEndStr]
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
      vacant_nights: Math.max(0, rangeNights - Number(r.booked_nights || 0)),
      revenue: String(r.revenue || '0'),
    }));

    // ─── NEW (RENTAL-DASH-1): ADR + RevPAR ───────────────────────────────────
    // ADR    = revenue / booked_nights         (per-stay average rate)
    // RevPAR = revenue / total_possible_nights (revenue per available unit-night)
    // Both are computed from values already in scope — no extra query.
    const revenueNum = Number(nightlyRevenue) || 0;
    const adr    = bookedNights > 0
      ? Math.round((revenueNum / bookedNights) * 1000) / 1000
      : 0;
    const revpar = totalPossibleNights > 0
      ? Math.round((revenueNum / totalPossibleNights) * 1000) / 1000
      : 0;

    // ─── NEW (RENTAL-DASH-1): Cancellation rate + ALOS + Lead time ───────────
    // One aggregate query covers all three. Counts ALL bookings overlapping
    // the range (cancelled included for the rate denominator), then derives
    // ALOS and lead_time only from realised stays.
    let cancellationRatePct = 0;
    let alos = 0;
    let leadTimeDays = 0;
    try {
      const aggRes = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_count,
           COUNT(*) FILTER (WHERE status IN ('confirmed','checked_in','completed','cancelled'))::int AS total_count,
           COALESCE(AVG(nights_count) FILTER (
             WHERE status IN ('confirmed','checked_in','completed') AND nights_count IS NOT NULL
           ), 0)::numeric(8,2) AS alos,
           COALESCE(AVG(checkin_date - created_at::date) FILTER (
             WHERE status IN ('confirmed','checked_in','completed')
               AND created_at::date <= checkin_date
           ), 0)::numeric(8,1) AS lead_time_days
         FROM bookings
         WHERE tenant_id=$1
           AND deleted_at IS NULL
           AND checkin_date IS NOT NULL
           AND checkout_date IS NOT NULL
           AND checkin_date < $3::date
           AND checkout_date > $2::date`,
        [tenantId, rangeStartStr, rangeEndStr]
      );
      const cancelledCount = Number(aggRes.rows?.[0]?.cancelled_count || 0);
      const totalCount     = Number(aggRes.rows?.[0]?.total_count     || 0);
      cancellationRatePct  = totalCount > 0
        ? Math.round((cancelledCount / totalCount) * 100)
        : 0;
      alos          = Number(aggRes.rows?.[0]?.alos           || 0);
      leadTimeDays  = Number(aggRes.rows?.[0]?.lead_time_days || 0);
    } catch (aggErr) {
      // Non-fatal — keep zeros if e.g. nights_count column missing.
      console.warn('dashboardSummary nightly: agg KPIs skipped', aggErr?.message);
    }

    // ─── NEW (RENTAL-DASH-1): Service share (Long Term vs Short Term) ────────
    // Replaces the timeslot service-share which is meaningless for nightly.
    // Returns booked_nights + revenue per service. Frontend displays as a
    // simple split, e.g. "Long Term Booking 558h / 75%  /  Short Term Booking
    // 186h / 25%".
    let serviceShare = [];
    try {
      const ssRes = await db.query(
        `SELECT
           COALESCE(s.id, 0) AS service_id,
           COALESCE(s.name, 'Unassigned') AS service_name,
           COALESCE(SUM(
             LEAST(b.checkout_date, $3::date) - GREATEST(b.checkin_date, $2::date)
           ) FILTER (WHERE b.status IN ('confirmed','checked_in','completed')), 0)::int AS booked_nights,
           COUNT(b.id) FILTER (WHERE b.status IN ('confirmed','checked_in','completed'))::int AS bookings_count,
           COALESCE(SUM(b.charge_amount) FILTER (WHERE b.status='confirmed'), 0)::numeric AS revenue
         FROM bookings b
         LEFT JOIN services s ON s.id = b.service_id
         WHERE b.tenant_id=$1
           AND b.deleted_at IS NULL
           AND b.checkin_date IS NOT NULL
           AND b.checkout_date IS NOT NULL
           AND b.checkin_date < $3::date
           AND b.checkout_date > $2::date
         GROUP BY s.id, s.name
         ORDER BY booked_nights DESC, revenue DESC`,
        [tenantId, rangeStartStr, rangeEndStr]
      );
      serviceShare = ssRes.rows.map((r) => ({
        service_id:    Number(r.service_id || 0),
        service_name:  String(r.service_name || 'Unassigned'),
        booked_nights: Number(r.booked_nights || 0),
        bookings_count: Number(r.bookings_count || 0),
        revenue:       String(r.revenue || '0'),
      }));
    } catch (ssErr) {
      console.warn('dashboardSummary nightly: service share skipped', ssErr?.message);
    }

    // ─── NEW (RENTAL-DASH-1): Booking pace (last 8 ISO weeks) ────────────────
    // Independent of selected range — operators want a trailing pace signal
    // ("are bookings speeding up or slowing down?"). Uses created_at (when
    // the booking was made), not checkin_date.
    let bookingPace = [];
    try {
      const paceRes = await db.query(
        `WITH weeks AS (
           SELECT generate_series(
             date_trunc('week', NOW() - INTERVAL '7 weeks'),
             date_trunc('week', NOW()),
             INTERVAL '1 week'
           ) AS week_start
         )
         SELECT
           w.week_start::date AS week_start,
           COUNT(b.id) FILTER (
             WHERE b.status IN ('confirmed','checked_in','completed','cancelled')
           )::int AS bookings_made,
           COUNT(b.id) FILTER (
             WHERE b.status IN ('confirmed','checked_in','completed')
           )::int AS bookings_kept
         FROM weeks w
         LEFT JOIN bookings b
           ON b.tenant_id = $1
          AND b.deleted_at IS NULL
          AND b.checkin_date IS NOT NULL
          AND b.checkout_date IS NOT NULL
          AND date_trunc('week', b.created_at) = w.week_start
         GROUP BY w.week_start
         ORDER BY w.week_start ASC`,
        [tenantId]
      );
      bookingPace = paceRes.rows.map((r) => ({
        week_start:    r.week_start,
        bookings_made: Number(r.bookings_made || 0),
        bookings_kept: Number(r.bookings_kept || 0),
      }));
    } catch (paceErr) {
      console.warn('dashboardSummary nightly: booking pace skipped', paceErr?.message);
    }

    nightlyKpis = {
      // Existing fields (unchanged)
      total_units: totalUnits,
      range_nights: rangeNights,
      booked_nights: bookedNights,
      occupancy_pct: occupancyPct,
      nightly_revenue: nightlyRevenue,
      by_unit: byUnit,
      // RENTAL-DASH-1 additions
      adr,
      revpar,
      cancellation_rate_pct: cancellationRatePct,
      alos,
      lead_time_days: leadTimeDays,
      service_share: serviceShare,
      booking_pace: bookingPace,
    };
  } catch (nightlyErr) {
    // Non-fatal — nightly dashboard requires migration 024 columns
    console.warn('dashboardSummary: nightly occupancy skipped', nightlyErr?.message);
  }

  return nightlyKpis;
}

module.exports = { buildNightlySection };
