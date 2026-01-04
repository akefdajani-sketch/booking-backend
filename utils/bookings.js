// utils/bookings.js
const { pool } = require("../db");
const db = pool;
/**
 * Returns true if two time ranges overlap.
 * We rely on SQL overlap checks instead of doing it in JS.
 *
 * Conflicts are checked within the same tenant and (optionally) for staff/resource.
 * If staffId/resourceId are not provided, those constraints are not applied.
 *
 * @param {object} args
 * @param {number} args.tenantId
 * @param {Date|string} args.startTime        - booking start in UTC (Date or ISO string)
 * @param {number} args.durationMinutes
 * @param {number|null|undefined} args.staffId
 * @param {number|null|undefined} args.resourceId
 * @param {number|null|undefined} args.excludeBookingId  - ignore this booking id (used for updates)
 * @returns {Promise<{ conflict: boolean, conflicts: any[] }>}
 */
async function checkConflicts({
  tenantId,
  startTime,
  durationMinutes,
  staffId,
  resourceId,
  excludeBookingId,
}) {
  const tId = Number(tenantId);
  if (!tId) throw new Error("checkConflicts: tenantId is required");

  const dur = Number(durationMinutes);
  if (!dur || dur < 1) throw new Error("checkConflicts: durationMinutes is required");

  const startIso =
    startTime instanceof Date ? startTime.toISOString() : new Date(startTime).toISOString();

  const staff = staffId != null && staffId !== "" ? Number(staffId) : null;
  const resource = resourceId != null && resourceId !== "" ? Number(resourceId) : null;
  const excludeId =
    excludeBookingId != null && excludeBookingId !== "" ? Number(excludeBookingId) : null;

  // We treat these statuses as "blocking time".
  // If your app blocks on more statuses, add them here.
  const blockingStatuses = ["pending", "confirmed"];

  // Overlap condition:
  // existing.start < newEnd AND existing.end > newStart
  //
  // newEnd = newStart + interval 'X minutes'
  const params = [tId, startIso, dur, blockingStatuses];
  let idx = params.length + 1;

  let where = `
    b.tenant_id = $1
    AND b.status = ANY($4)
    AND b.start_time < ($2::timestamptz + ($3::int || ' minutes')::interval)
    AND (b.start_time + (b.duration_minutes::int || ' minutes')::interval) > $2::timestamptz
  `;

  if (excludeId) {
    params.push(excludeId);
    where += ` AND b.id <> $${params.length}`;
  }

  // If a service requires staff/resource, your create route will pass staff/resource.
  // We only enforce conflict check when that id exists.
  if (staff) {
    params.push(staff);
    where += ` AND b.staff_id = $${params.length}`;
  }
  if (resource) {
    params.push(resource);
    where += ` AND b.resource_id = $${params.length}`;
  }

  const q = `
    SELECT
      b.id,
      b.start_time,
      b.duration_minutes,
      b.status,
      b.service_id,
      b.staff_id,
      b.resource_id
    FROM bookings b
    WHERE ${where}
    ORDER BY b.start_time ASC
    LIMIT 20
  `;

  const result = await db.query(q, params);
  const conflicts = result.rows || [];

  return { conflict: conflicts.length > 0, conflicts };
}

/**
 * Loads a booking by id and returns a "joined" row used by the frontend:
 * - service_name
 * - staff_name
 * - resource_name
 * - tenant_slug / tenant_name (optional but helpful)
 *
 * IMPORTANT: column names here match your newer frontend types:
 * start_time, duration_minutes, status, etc.
 *
 * @param {number} bookingId
 * @returns {Promise<object|null>}
 */
async function loadJoinedBookingById(bookingId, tenantId) {
  const id = Number(bookingId);
  if (!id) throw new Error("loadJoinedBookingById: bookingId is required");

  const tId = tenantId != null && tenantId !== "" ? Number(tenantId) : null;
  if (tId != null && (!Number.isFinite(tId) || tId <= 0)) {
    throw new Error("loadJoinedBookingById: invalid tenantId");
  }

  const q = `
    SELECT
      b.id,
      b.tenant_id,
      t.slug AS tenant_slug,
      t.name AS tenant_name,

      b.service_id,
      s.name AS service_name,

      b.staff_id,
      st.name AS staff_name,

      b.resource_id,
      r.name AS resource_name,

      b.customer_id,
      b.customer_name,
      b.customer_phone,
      b.customer_email,

      b.start_time,
      b.duration_minutes,
      b.status,
      b.created_at,
      b.booking_code
    FROM bookings b
    JOIN tenants t ON t.id = b.tenant_id
    LEFT JOIN services s ON s.tenant_id = b.tenant_id AND s.id = b.service_id
    LEFT JOIN staff st ON st.tenant_id = b.tenant_id AND st.id = b.staff_id
    LEFT JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
    WHERE b.id = $1
      AND ($2::int IS NULL OR b.tenant_id = $2::int)
    LIMIT 1
  `;

  const result = await db.query(q, [id, tId]);
  return result.rows?.[0] || null;
}

module.exports = {
  checkConflicts,
  loadJoinedBookingById,
};
