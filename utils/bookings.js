// utils/bookings.js
const { pool } = require("../db");
const db = pool;

// ─── findOrCreateSession ──────────────────────────────────────────────────────
/**
 * For services with max_parallel_bookings > 1, find an existing OPEN session
 * for the given slot or create a new one atomically.
 *
 * Returns { sessionId, spotsRemaining, full: false } on success.
 * Returns { sessionId: null, full: true } when the session is at capacity.
 *
 * Must be called inside a DB client transaction (pass client, not pool).
 */
async function findOrCreateSession({
  client,
  tenantId,
  serviceId,
  resourceId,
  staffId,
  startTimeIso,
  durationMinutes,
  maxCapacity,
}) {
  const tId   = Number(tenantId);
  const svcId = Number(serviceId);
  const resId = resourceId != null && resourceId !== "" ? Number(resourceId) : null;
  const stfId = staffId    != null && staffId    !== "" ? Number(staffId)    : null;
  const cap   = Number(maxCapacity) || 1;

  // Lock the row so concurrent requests serialise here
  const findRes = await client.query(
    `SELECT id, confirmed_count, max_capacity, status
     FROM service_sessions
     WHERE tenant_id   = $1
       AND service_id  = $2
       AND resource_id IS NOT DISTINCT FROM $3
       AND start_time  = $4::timestamptz
     FOR UPDATE`,
    [tId, svcId, resId, startTimeIso]
  );

  if (findRes.rows.length > 0) {
    const session = findRes.rows[0];
    if (session.status === "full" || session.status === "cancelled") {
      return { sessionId: null, spotsRemaining: 0, full: true };
    }
    const spotsRemaining = session.max_capacity - session.confirmed_count;
    if (spotsRemaining <= 0) {
      await client.query(
        `UPDATE service_sessions SET status = 'full' WHERE id = $1`,
        [session.id]
      );
      return { sessionId: null, spotsRemaining: 0, full: true };
    }
    return { sessionId: session.id, spotsRemaining, full: false };
  }

  // No session yet — create one atomically
  const insertRes = await client.query(
    `INSERT INTO service_sessions
       (tenant_id, service_id, resource_id, staff_id,
        start_time, duration_minutes, max_capacity, confirmed_count, status)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, 0, 'open')
     ON CONFLICT ON CONSTRAINT uq_session_slot
       DO UPDATE SET max_capacity = service_sessions.max_capacity
     RETURNING id, confirmed_count, max_capacity, status`,
    [tId, svcId, resId, stfId, startTimeIso, durationMinutes, cap]
  );

  const newSession = insertRes.rows[0];
  if (newSession.status === "full" || newSession.confirmed_count >= newSession.max_capacity) {
    return { sessionId: null, spotsRemaining: 0, full: true };
  }

  return {
    sessionId: newSession.id,
    spotsRemaining: newSession.max_capacity - newSession.confirmed_count,
    full: false,
  };
}

// ─── incrementSessionCount ────────────────────────────────────────────────────
/**
 * Increments confirmed_count after a booking is inserted.
 * Sets status='full' when capacity is reached.
 * Must be called inside the same transaction as the booking INSERT.
 */
async function incrementSessionCount({ client, sessionId, maxCapacity }) {
  await client.query(
    `UPDATE service_sessions
     SET
       confirmed_count = confirmed_count + 1,
       status = CASE
         WHEN confirmed_count + 1 >= max_capacity THEN 'full'
         ELSE 'open'
       END
     WHERE id = $1`,
    [sessionId]
  );
}

// ─── decrementSessionCount ────────────────────────────────────────────────────
/**
 * Decrements confirmed_count when a parallel booking is cancelled.
 * Re-opens a 'full' session. Sets 'cancelled' when it hits 0.
 */
async function decrementSessionCount({ sessionId }) {
  await db.query(
    `UPDATE service_sessions
     SET
       confirmed_count = GREATEST(confirmed_count - 1, 0),
       status = CASE
         WHEN status = 'cancelled' THEN 'cancelled'
         WHEN GREATEST(confirmed_count - 1, 0) <= 0 THEN 'cancelled'
         ELSE 'open'
       END
     WHERE id = $1`,
    [sessionId]
  );
}

// ─── checkConflicts ───────────────────────────────────────────────────────────
/**
 * Session-aware conflict checker.
 *
 * Parallel service (maxParallel > 1):
 *   - Any booking OR session for a DIFFERENT service on same resource → conflict
 *   - Same-service capacity handled by findOrCreateSession, not here
 *
 * Regular service (maxParallel = 1):
 *   - Original logic fully preserved
 *   - Also blocked if any parallel session owns the resource
 */
async function checkConflicts({
  tenantId,
  startTime,
  durationMinutes,
  staffId,
  resourceId,
  excludeBookingId,
  serviceId   = null,
  maxParallel = 1,
}) {
  const tId = Number(tenantId);
  if (!tId) throw new Error("checkConflicts: tenantId is required");

  const dur = Number(durationMinutes);
  if (!dur || dur < 1) throw new Error("checkConflicts: durationMinutes is required");

  const startIso =
    startTime instanceof Date ? startTime.toISOString() : new Date(startTime).toISOString();

  const staff     = staffId        != null && staffId        !== "" ? Number(staffId)        : null;
  const resource  = resourceId     != null && resourceId     !== "" ? Number(resourceId)     : null;
  const excludeId = excludeBookingId != null && excludeBookingId !== "" ? Number(excludeBookingId) : null;
  const svcId     = serviceId      != null && serviceId      !== "" ? Number(serviceId)      : null;
  const isParallel = Number(maxParallel) > 1;

  // ── Parallel service path ──────────────────────────────────────────────────
  if (isParallel && resource && svcId) {
    const params = [tId, startIso, dur, ["pending", "confirmed"], resource, svcId];
    let excludeClause = "";
    if (excludeId) {
      params.push(excludeId);
      excludeClause = `AND b.id <> $${params.length}`;
    }

    const bookingConflict = await db.query(
      `SELECT b.id, b.start_time, b.duration_minutes, b.status, b.service_id, b.resource_id
       FROM bookings b
       WHERE b.tenant_id   = $1
         AND b.status      = ANY($4)
         AND b.resource_id = $5
         AND b.service_id  <> $6
         AND b.start_time  < ($2::timestamptz + ($3::int || ' minutes')::interval)
         AND (b.start_time + (b.duration_minutes::int || ' minutes')::interval) > $2::timestamptz
         AND b.deleted_at IS NULL
         ${excludeClause}
       LIMIT 5`,
      params
    );

    if (bookingConflict.rows.length > 0) {
      return {
        conflict: true,
        conflicts: bookingConflict.rows,
        reason: "resource_owned_by_different_service",
      };
    }

    const sessionConflict = await db.query(
      `SELECT ss.id, ss.start_time, ss.duration_minutes, ss.service_id, ss.resource_id
       FROM service_sessions ss
       WHERE ss.tenant_id   = $1
         AND ss.resource_id = $2
         AND ss.service_id  <> $3
         AND ss.status      <> 'cancelled'
         AND ss.start_time  < ($4::timestamptz + ($5::int || ' minutes')::interval)
         AND (ss.start_time + (ss.duration_minutes::int || ' minutes')::interval) > $4::timestamptz
       LIMIT 5`,
      [tId, resource, svcId, startIso, dur]
    );

    if (sessionConflict.rows.length > 0) {
      return {
        conflict: true,
        conflicts: sessionConflict.rows,
        reason: "resource_owned_by_session_of_different_service",
      };
    }

    return { conflict: false, conflicts: [] };
  }

  // ── Regular service path (original logic, fully preserved) ────────────────

  // Also block if a parallel session owns this resource in this window
  if (resource) {
    const sessionBlock = await db.query(
      `SELECT ss.id, ss.start_time, ss.service_id
       FROM service_sessions ss
       WHERE ss.tenant_id   = $1
         AND ss.resource_id = $2
         AND ss.status      <> 'cancelled'
         AND ss.start_time  < ($3::timestamptz + ($4::int || ' minutes')::interval)
         AND (ss.start_time + (ss.duration_minutes::int || ' minutes')::interval) > $3::timestamptz
       LIMIT 5`,
      [tId, resource, startIso, dur]
    );
    if (sessionBlock.rows.length > 0) {
      return {
        conflict: true,
        conflicts: sessionBlock.rows,
        reason: "resource_owned_by_parallel_session",
      };
    }
  }

  const blockingStatuses = ["pending", "confirmed"];
  const params = [tId, startIso, dur, blockingStatuses];

  let where = `
    b.tenant_id = $1
    AND b.status = ANY($4)
    AND b.start_time < ($2::timestamptz + ($3::int || ' minutes')::interval)
    AND (b.start_time + (b.duration_minutes::int || ' minutes')::interval) > $2::timestamptz
    AND b.deleted_at IS NULL
  `;

  if (excludeId) {
    params.push(excludeId);
    where += ` AND b.id <> $${params.length}`;
  }
  if (staff) {
    params.push(staff);
    where += ` AND b.staff_id = $${params.length}`;
  }
  if (resource) {
    params.push(resource);
    where += ` AND b.resource_id = $${params.length}`;
  }

  const q = `
    SELECT b.id, b.start_time, b.duration_minutes, b.status, b.service_id, b.staff_id, b.resource_id
    FROM bookings b
    WHERE ${where}
    ORDER BY b.start_time ASC
    LIMIT 20
  `;

  const result = await db.query(q, params);
  const conflicts = result.rows || [];

  return { conflict: conflicts.length > 0, conflicts };
}

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
      b.customer_membership_id,

      b.start_time,
      b.duration_minutes,
      b.status,
      b.created_at,
      b.booking_code,

      -- RENTAL-1: nightly booking fields (NULL for time-slot bookings)
      b.booking_mode,
      b.checkin_date,
      b.checkout_date,
      b.nights_count,
      b.guests_count,
      b.addons_json,
      b.addons_total,

      -- Money + applied Rates snapshot (optional columns; present in v1 hardened schema)
      b.price_amount,
      b.charge_amount,
      b.currency_code,
      b.payment_method,
      b.applied_rate_rule_id,
      b.applied_rate_snapshot,
      rr.name AS applied_rate_rule_name,

      mp.name AS membership_plan_name,
      cm.minutes_remaining AS membership_minutes_remaining,
      cm.uses_remaining AS membership_uses_remaining,
      mu.minutes_used AS membership_minutes_used_for_booking,
      mu.uses_used AS membership_uses_used_for_booking,
      COALESCE(pr.prepaid_applied, false) AS prepaid_applied,
      pr.prepaid_redemption_id,
      pr.prepaid_entitlement_id,
      pr.prepaid_product_id,
      pr.prepaid_product_name,
      pr.prepaid_redemption_mode,
      pr.prepaid_quantity_used,
      pr.prepaid_quantity_remaining
    FROM bookings b
    JOIN tenants t ON t.id = b.tenant_id
    LEFT JOIN services s ON s.tenant_id = b.tenant_id AND s.id = b.service_id
    LEFT JOIN staff st ON st.tenant_id = b.tenant_id AND st.id = b.staff_id
    LEFT JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
    LEFT JOIN rate_rules rr ON rr.tenant_id = b.tenant_id AND rr.id = b.applied_rate_rule_id
    LEFT JOIN customer_memberships cm ON cm.id = b.customer_membership_id
    LEFT JOIN membership_plans mp ON mp.id = cm.plan_id
    LEFT JOIN LATERAL (
      SELECT
        SUM(CASE WHEN ml.minutes_delta < 0 THEN -ml.minutes_delta ELSE 0 END)::int AS minutes_used,
        SUM(CASE WHEN ml.uses_delta < 0 THEN -ml.uses_delta ELSE 0 END)::int AS uses_used
      FROM membership_ledger ml
      WHERE ml.booking_id = b.id
        AND (b.customer_membership_id IS NULL OR ml.customer_membership_id = b.customer_membership_id)
    ) mu ON true
    LEFT JOIN LATERAL (
      SELECT
        true AS prepaid_applied,
        pr.id AS prepaid_redemption_id,
        pr.entitlement_id AS prepaid_entitlement_id,
        pr.prepaid_product_id,
        pp.name AS prepaid_product_name,
        pr.redemption_mode AS prepaid_redemption_mode,
        pr.redeemed_quantity AS prepaid_quantity_used,
        e.remaining_quantity AS prepaid_quantity_remaining
      FROM prepaid_redemptions pr
      LEFT JOIN customer_prepaid_entitlements e
        ON e.id = pr.entitlement_id
       AND e.tenant_id = pr.tenant_id
      LEFT JOIN prepaid_products pp
        ON pp.id = pr.prepaid_product_id
       AND pp.tenant_id = pr.tenant_id
      WHERE pr.booking_id = b.id
      ORDER BY pr.id DESC
      LIMIT 1
    ) pr ON true
    WHERE b.id = $1
      AND ($2::int IS NULL OR b.tenant_id = $2::int)
    LIMIT 1
  `;

  const result = await db.query(q, [id, tId]);
  return result.rows?.[0] || null;
}

module.exports = {
  checkConflicts,
  findOrCreateSession,
  incrementSessionCount,
  decrementSessionCount,
  loadJoinedBookingById,
};
