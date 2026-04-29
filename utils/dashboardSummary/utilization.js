// utils/dashboardSummary/utilization.js
//
// Computes tenant-level utilization:
//   - openMinutesTotal: total opening hours across the range, in minutes
//   - capacityMinutes: openMinutesTotal × capacityUnits
//   - utilizationPct:  bookedMinutes / capacityMinutes × 100
//
// Also computes no-show rate (used by alerts and pulse).
//
// Why open-minutes math is here and not in dashboardHelpers: the cursor
// loop needs the rangeStart/rangeEnd from ctx, and replicating it in
// staff.js (which also needs it for staffWeeklySchedule) would be more
// duplication than it's worth.

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @param {object} kpi the result of buildKpiSection — needs bookedMinutes
 * @returns {Promise<{
 *   utilizationPct, openMinutesTotal,
 *   noShowCount, noShowEligibleCount, noShowRate,
 *   tenantHourRows,
 * }>}
 */
async function buildUtilizationSection(ctx, kpi) {
  const {
    db, tenantId, startCol, staffClause, rangeStart, rangeEnd, capacityUnits,
  } = ctx;
  const { bookedMinutes } = kpi;

  let utilizationPct = null;
  let openMinutesTotal = 0;
  let tenantHourRows = [];

  const hoursReg = await db.query(`SELECT to_regclass('public.tenant_hours') AS reg`);
  if (hoursReg.rows?.[0]?.reg && capacityUnits > 0) {
    // tenant_hours schema in this codebase uses open_time/close_time/is_closed
    // (see routes/tenantHours.js). Older dashboard implementations mistakenly
    // referenced start_time/end_time which do not exist.
    const hours = await db.query(
      `SELECT day_of_week, open_time, close_time, is_closed
       FROM tenant_hours
       WHERE tenant_id=$1`,
      [tenantId]
    );
    tenantHourRows = hours.rows || [];

    let openMinutes = 0;
    const cursor = new Date(rangeStart.getTime());
    while (cursor.getTime() < rangeEnd.getTime()) {
      const dow = cursor.getUTCDay();
      const todays = tenantHourRows.filter((r) => Number(r.day_of_week) === dow);
      for (const r of todays) {
        if (r.is_closed === true) continue;
        const st = String(r.open_time || "").slice(0, 5);
        const et = String(r.close_time || "").slice(0, 5);
        if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) continue;
        const [sh, sm] = st.split(":").map(Number);
        const [eh, em] = et.split(":").map(Number);
        const startMin = sh * 60 + sm;
        let endMin = eh * 60 + em;

        // Support "overnight" schedules and the common pattern where close_time is stored as 00:00
        // to represent "midnight at end of day" (e.g. 10:00 → 00:00 should mean 14 hours, not 0).
        // If end <= start, treat close as next-day.
        if (endMin <= startMin) endMin += 24 * 60;

        const mins = endMin - startMin;
        if (mins > 0) openMinutes += mins;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    openMinutesTotal = openMinutes;
    const capacityMinutes = openMinutes * capacityUnits;
    if (capacityMinutes > 0) utilizationPct = Math.round((bookedMinutes / capacityMinutes) * 100);
  } else {
    // Even when capacity is 0, we still try to read tenant_hours for
    // downstream use in resources.js (heatmap needs them).
    if (hoursReg.rows?.[0]?.reg) {
      try {
        const hours = await db.query(
          `SELECT day_of_week, open_time, close_time, is_closed FROM tenant_hours WHERE tenant_id=$1`,
          [tenantId]
        );
        tenantHourRows = hours.rows || [];
      } catch {}
    }
  }

  // No-show rate
  const eligibleNoShowStatuses = ['confirmed', 'checked_in', 'completed', 'no_show', 'noshow', 'completed_absent'];
  const noShowStatuses = ['no_show', 'noshow', 'completed_absent'];
  let noShowCount = 0;
  let noShowEligibleCount = 0;
  try {
    const noShowAgg = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = ANY($4::text[]))::int AS no_show_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = ANY($5::text[]))::int AS eligible_count
      FROM bookings b
      WHERE b.tenant_id=$1
        ${staffClause}
        AND ${startCol} >= $2
        AND ${startCol} < $3
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString(), noShowStatuses, eligibleNoShowStatuses]
    );
    noShowCount = Number(noShowAgg.rows?.[0]?.no_show_count || 0);
    noShowEligibleCount = Number(noShowAgg.rows?.[0]?.eligible_count || 0);
  } catch {}
  const noShowRate = noShowEligibleCount > 0 ? Number(((noShowCount / noShowEligibleCount) * 100).toFixed(1)) : 0;

  return {
    utilizationPct,
    openMinutesTotal,
    noShowCount,
    noShowEligibleCount,
    noShowRate,
    tenantHourRows,
  };
}

module.exports = { buildUtilizationSection };
