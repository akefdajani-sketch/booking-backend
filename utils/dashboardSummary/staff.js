// utils/dashboardSummary/staff.js
//
// Staff utilization / load in the selected range.
// Returns top 6 service-providing staff by booked minutes, with per-staff
// utilization percentage based on either the staff_weekly_schedule
// table (if available) or the tenant_hours fallback.
//
// v2 §3.1 fix: only show staff who actually deliver services. Filters
// out owner/admin login accounts that aren't service providers.

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @returns {Promise<Array<{
 *   staff_id, staff_name, booked_minutes, utilization_pct,
 * }>>}
 */
async function buildStaffSection(ctx) {
  const { db, tenantId, startCol, rangeStart, rangeEnd, staffCount } = ctx;

  let staffUtilization = [];
  if (staffCount === 0) return staffUtilization;

  try {
    // Determine open-minutes-per-staff using staff_weekly_schedule first,
    // then fall back to tenant_hours.
    const staffHoursReg = await db.query(`SELECT to_regclass('public.staff_weekly_schedule') AS reg`);
    let openMinutesPerStaff = 0;

    if (staffHoursReg.rows?.[0]?.reg) {
      const staffHours = await db.query(
        `SELECT day_of_week, start_time, end_time, is_off FROM staff_weekly_schedule WHERE tenant_id=$1`,
        [tenantId]
      );
      const rows = staffHours.rows || [];
      openMinutesPerStaff = computeWeeklyOpenMinutes(rows, rangeStart, rangeEnd, 'start_time', 'end_time', 'is_off');
    }

    // Fallback: use tenant_hours if staff_weekly_schedule didn't yield any time
    if (!openMinutesPerStaff) {
      const hoursReg2 = await db.query(`SELECT to_regclass('public.tenant_hours') AS reg`);
      if (hoursReg2.rows?.[0]?.reg) {
        const hours = await db.query(
          `SELECT day_of_week, open_time, close_time, is_closed FROM tenant_hours WHERE tenant_id=$1`,
          [tenantId]
        );
        const rows = hours.rows || [];
        openMinutesPerStaff = computeWeeklyOpenMinutes(rows, rangeStart, rangeEnd, 'open_time', 'close_time', 'is_closed');
      }
    }

    const staffLoad = await db.query(
      `
      SELECT
        st.id AS staff_id,
        COALESCE(NULLIF(TRIM(st.name), ''), 'Staff') AS staff_name,
        COALESCE(SUM(b.duration_minutes) FILTER (WHERE b.status='confirmed' AND ${startCol} >= $2 AND ${startCol} < $3), 0)::int AS booked_minutes
      FROM staff st
      LEFT JOIN bookings b
        ON b.tenant_id=st.tenant_id
       AND b.staff_id=st.id
      WHERE st.tenant_id=$1
        -- v2 §3.1 fix: only show staff who actually deliver services.
        -- Filters out owner/admin login accounts that are not service providers.
        AND EXISTS (
          SELECT 1 FROM staff_service_links ssl
          WHERE ssl.staff_id = st.id
        )
      GROUP BY st.id, st.name
      ORDER BY booked_minutes DESC, staff_name ASC
      LIMIT 6
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    staffUtilization = (staffLoad.rows || []).map((r) => {
      const booked = Number(r.booked_minutes || 0);
      return {
        staff_id: Number(r.staff_id),
        staff_name: String(r.staff_name || 'Staff'),
        booked_minutes: booked,
        utilization_pct: openMinutesPerStaff > 0 ? Math.round((booked / openMinutesPerStaff) * 100) : null,
      };
    });
  } catch {}

  return staffUtilization;
}

// Walk the date range day by day, summing minutes for each day's
// schedule rows. Generic over the column names so we can use it with
// either staff_weekly_schedule or tenant_hours.
function computeWeeklyOpenMinutes(rows, rangeStart, rangeEnd, startKey, endKey, offKey) {
  let openMinutes = 0;
  const cursor = new Date(rangeStart.getTime());
  while (cursor.getTime() < rangeEnd.getTime()) {
    const dow = cursor.getUTCDay();
    const todays = rows.filter((r) => Number(r.day_of_week) === dow);
    for (const r of todays) {
      if (r[offKey] === true) continue;
      const st = String(r[startKey] || '').slice(0, 5);
      const et = String(r[endKey] || '').slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) continue;
      const [sh, sm] = st.split(':').map(Number);
      const [eh, em] = et.split(':').map(Number);
      const startMin = sh * 60 + sm;
      let endMin = eh * 60 + em;
      if (endMin <= startMin) endMin += 24 * 60;
      const mins = endMin - startMin;
      if (mins > 0) openMinutes += mins;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return openMinutes;
}

module.exports = { buildStaffSection };
