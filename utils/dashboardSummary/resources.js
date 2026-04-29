// utils/dashboardSummary/resources.js
//
// Three related sections, all keyed off open-minutes capacity:
//   - byResource:    per-resource utilization (top 8 by booked minutes)
//   - byService:     per-service share of bookings/minutes (top 8)
//   - hourlyHeatmap: bookings per bucket vs capacity per bucket
//
// All three are independently try/catched. Heatmap also computes peak
// hours / dead zones (consumed by alerts).

const {
  buildBucketStarts,
  bucketLabel,
  computeOpenMinutesForBucket,
  roundPct,
} = require("../dashboardHelpers");

/**
 * @param {ReturnType<import('./context').buildContext>} ctx
 * @param {object} util  buildUtilizationSection result (needs openMinutesTotal, tenantHourRows)
 * @returns {Promise<{
 *   byResource, byService, hourlyHeatmap, peakHours, deadZones,
 * }>}
 */
async function buildResourcesSection(ctx, util) {
  const {
    db, tenantId, startCol, staffClause, rangeStart, rangeEnd,
    mode, capacityUnits, resourceCount,
  } = ctx;
  const { openMinutesTotal, tenantHourRows } = util;

  let byResource = [];
  let byService = [];
  let hourlyHeatmap = [];

  // Per-resource utilization
  try {
    const resourceReg = await db.query(`SELECT to_regclass('public.resources') AS reg`);
    if (resourceReg.rows?.[0]?.reg && resourceCount > 0) {
      const qr = await db.query(
        `
        SELECT
          r.id AS resource_id,
          COALESCE(NULLIF(TRIM(r.name), ''), 'Resource') AS resource_name,
          COALESCE(SUM(b.duration_minutes) FILTER (WHERE b.status='confirmed' AND ${startCol} >= $2 AND ${startCol} < $3), 0)::int AS booked_minutes
        FROM resources r
        LEFT JOIN bookings b
          ON b.tenant_id=r.tenant_id
         AND b.resource_id=r.id
        WHERE r.tenant_id=$1
        GROUP BY r.id, r.name
        ORDER BY booked_minutes DESC, resource_name ASC
        LIMIT 8
        `,
        [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
      );
      byResource = (qr.rows || []).map((r) => {
        const booked = Number(r.booked_minutes || 0);
        return {
          resource_id: Number(r.resource_id),
          resource_name: String(r.resource_name || 'Resource'),
          booked_minutes: booked,
          available_minutes: openMinutesTotal,
          utilization_pct: roundPct(booked, openMinutesTotal),
        };
      });
    }
  } catch {}

  // Per-service share
  try {
    const qSvc = await db.query(
      `
      SELECT
        COALESCE(s.id, 0) AS service_id,
        COALESCE(s.name, 'Service') AS service_name,
        COALESCE(SUM(b.duration_minutes) FILTER (WHERE b.status='confirmed'), 0)::int AS booked_minutes,
        COUNT(*) FILTER (WHERE b.status='confirmed')::int AS bookings_count
      FROM bookings b
      LEFT JOIN services s ON s.id=b.service_id
      WHERE b.tenant_id=$1
        ${staffClause}
        AND ${startCol} >= $2
        AND ${startCol} < $3
      GROUP BY 1, 2
      ORDER BY booked_minutes DESC, bookings_count DESC, service_name ASC
      LIMIT 8
      `,
      [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    const totalServiceMinutes = (qSvc.rows || []).reduce((sum, r) => sum + Number(r.booked_minutes || 0), 0);
    byService = (qSvc.rows || []).map((r) => ({
      service_id: Number(r.service_id || 0),
      service_name: String(r.service_name || 'Service'),
      booked_minutes: Number(r.booked_minutes || 0),
      bookings_count: Number(r.bookings_count || 0),
      share_pct: roundPct(Number(r.booked_minutes || 0), totalServiceMinutes),
    }));
  } catch {}

  // Hourly heatmap
  try {
    const bucketStarts = buildBucketStarts(mode, rangeStart, rangeEnd);
    const bucketAgg = await db.query(
      `
      SELECT
        date_trunc('${ctx.truncUnit}', ${startCol}) AS bucket,
        COALESCE(SUM(duration_minutes) FILTER (WHERE status='confirmed'), 0)::int AS booked_minutes
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
    const bookedByBucket = new Map((bucketAgg.rows || []).map((r) => [new Date(r.bucket).toISOString(), Number(r.booked_minutes || 0)]));
    hourlyHeatmap = bucketStarts.map((bucketDate) => {
      const key = bucketDate.toISOString();
      const booked = Number(bookedByBucket.get(key) || 0);
      const openMinutesForBucket = computeOpenMinutesForBucket(tenantHourRows, mode, bucketDate);
      const capacityMinutes = Math.max(0, openMinutesForBucket * Math.max(1, capacityUnits || 1));
      return {
        bucket: key,
        label: bucketLabel(mode, bucketDate),
        booked_minutes: booked,
        capacity_minutes: capacityMinutes,
        utilization_pct: roundPct(booked, capacityMinutes) ?? 0,
      };
    });
  } catch {}

  // Peak hours / dead zones derived from heatmap
  const peakHours = (hourlyHeatmap || [])
    .filter((row) => Number(row.capacity_minutes || 0) > 0)
    .slice()
    .sort((a, b) => Number(b.utilization_pct || 0) - Number(a.utilization_pct || 0)
                  || Number(b.booked_minutes || 0) - Number(a.booked_minutes || 0))
    .slice(0, 3)
    .map((row) => row.label);
  const deadZones = (hourlyHeatmap || [])
    .filter((row) => Number(row.capacity_minutes || 0) > 0)
    .slice()
    .sort((a, b) => Number(a.utilization_pct || 0) - Number(b.utilization_pct || 0)
                  || Number(a.booked_minutes || 0) - Number(b.booked_minutes || 0))
    .slice(0, 3)
    .map((row) => row.label);

  return { byResource, byService, hourlyHeatmap, peakHours, deadZones };
}

module.exports = { buildResourcesSection };
