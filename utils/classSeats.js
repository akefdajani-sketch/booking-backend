'use strict';

// utils/classSeats.js
// G1: Core operations for class session seats and waitlist.
// All operations are tenant-scoped. Caller is responsible for auth.

const db = require('../db');
const logger = require('./logger');

// ─── Session loading ────────────────────────────────────────────────────────

async function loadSession({ client, tenantId, sessionId }) {
  const r = await (client || db).query(
    `SELECT * FROM class_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  );
  return r.rows[0] || null;
}

/**
 * Get derived counts for a session: confirmed seats, available, waitlist size.
 */
async function loadSessionCounts({ client, tenantId, sessionId }) {
  const q = client || db;
  const seats = await q.query(
    `SELECT COUNT(*)::int AS n
     FROM class_session_seats
     WHERE tenant_id = $1 AND session_id = $2 AND status IN ('confirmed','checked_in')`,
    [tenantId, sessionId]
  );
  const wait = await q.query(
    `SELECT COUNT(*)::int AS n
     FROM class_session_waitlist
     WHERE tenant_id = $1 AND session_id = $2 AND status = 'waiting'`,
    [tenantId, sessionId]
  );
  return {
    booked: seats.rows[0]?.n ?? 0,
    waitlistSize: wait.rows[0]?.n ?? 0,
  };
}

// ─── Book a seat ────────────────────────────────────────────────────────────

/**
 * Reserve a seat for a customer in a session. Atomic — uses a row lock on
 * the session to prevent race conditions when capacity is near full.
 *
 * Returns:
 *   { ok: true, seat }                — booked
 *   { ok: false, code: 'session_not_found' }
 *   { ok: false, code: 'session_cancelled' }
 *   { ok: false, code: 'session_full', waitlist_eligible: bool }
 *   { ok: false, code: 'duplicate_seat' }   — customer already booked
 */
async function bookSeat({ tenantId, sessionId, customerId, bookingId = null, amountPaid = 0, currencyCode = null }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the session row so concurrent bookSeat calls serialise
    const sRes = await client.query(
      `SELECT * FROM class_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [sessionId, tenantId]
    );
    const session = sRes.rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'session_not_found' };
    }
    if (session.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { ok: false, code: 'session_cancelled' };
    }

    // Capacity check
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM class_session_seats
       WHERE tenant_id = $1 AND session_id = $2 AND status IN ('confirmed','checked_in')`,
      [tenantId, sessionId]
    );
    const booked = countRes.rows[0]?.n ?? 0;
    if (booked >= Number(session.capacity)) {
      // Check waitlist eligibility on the parent service
      const svc = await client.query(
        `SELECT waitlist_enabled FROM services
         WHERE id = $1 AND tenant_id = $2`,
        [session.service_id, tenantId]
      );
      const waitlistEligible = Boolean(svc.rows[0]?.waitlist_enabled);
      await client.query('ROLLBACK');
      return { ok: false, code: 'session_full', waitlist_eligible: waitlistEligible };
    }

    // Insert seat. Unique partial index on (session_id, customer_id) where
    // status IN ('confirmed','checked_in') guards against duplicates.
    let seatRow;
    try {
      const ins = await client.query(
        `INSERT INTO class_session_seats
           (tenant_id, session_id, customer_id, booking_id, status,
            amount_paid, currency_code, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'confirmed', $5, $6, NOW(), NOW())
         RETURNING *`,
        [tenantId, sessionId, customerId, bookingId, amountPaid, currencyCode]
      );
      seatRow = ins.rows[0];
    } catch (err) {
      // unique_violation
      if (err && err.code === '23505') {
        await client.query('ROLLBACK');
        return { ok: false, code: 'duplicate_seat' };
      }
      throw err;
    }

    await client.query('COMMIT');
    logger.info(
      { tenantId, sessionId, customerId, seatId: seatRow.id, bookingId },
      'class seat booked'
    );
    return { ok: true, seat: seatRow };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    logger.error(
      { err: err.message, tenantId, sessionId, customerId },
      'bookSeat failed'
    );
    throw err;
  } finally {
    client.release();
  }
}

// ─── Cancel a seat (with auto-promote) ─────────────────────────────────────

/**
 * Cancel a seat. If the session has a waiting list, automatically promote
 * the #1 person on the waitlist to a confirmed seat.
 *
 * Returns:
 *   {
 *     ok: true,
 *     seat,                              // the cancelled seat row
 *     promoted: { seat, waitlist_id }   // null if nobody was on the waitlist
 *   }
 *   { ok: false, code: 'seat_not_found' }
 *   { ok: false, code: 'seat_already_cancelled' }
 */
async function cancelSeat({ tenantId, seatId, cancelledBy = 'staff' }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the seat
    const sRes = await client.query(
      `SELECT * FROM class_session_seats
       WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [seatId, tenantId]
    );
    const seat = sRes.rows[0];
    if (!seat) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'seat_not_found' };
    }
    if (seat.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { ok: false, code: 'seat_already_cancelled' };
    }

    // Cancel the seat
    const cancelled = await client.query(
      `UPDATE class_session_seats
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancelled_by = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [cancelledBy, seatId]
    );
    const cancelledSeat = cancelled.rows[0];

    // Look for the #1 waitlist entry on this session
    const waitRes = await client.query(
      `SELECT * FROM class_session_waitlist
       WHERE tenant_id = $1
         AND session_id = $2
         AND status = 'waiting'
       ORDER BY position ASC, created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [tenantId, seat.session_id]
    );

    let promoted = null;
    if (waitRes.rows.length > 0) {
      const w = waitRes.rows[0];

      // Create the new seat for the promoted customer
      const newSeat = await client.query(
        `INSERT INTO class_session_seats
           (tenant_id, session_id, customer_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'confirmed', NOW(), NOW())
         RETURNING *`,
        [tenantId, seat.session_id, w.customer_id]
      );

      // Mark the waitlist entry as promoted
      await client.query(
        `UPDATE class_session_waitlist
         SET status = 'promoted',
             promoted_at = NOW(),
             promoted_seat_id = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [newSeat.rows[0].id, w.id]
      );

      promoted = { seat: newSeat.rows[0], waitlist_id: w.id };
    }

    await client.query('COMMIT');
    logger.info(
      {
        tenantId, sessionId: seat.session_id, seatId,
        autoPromoted: Boolean(promoted),
      },
      'class seat cancelled'
    );
    return { ok: true, seat: cancelledSeat, promoted };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    logger.error(
      { err: err.message, tenantId, seatId },
      'cancelSeat failed'
    );
    throw err;
  } finally {
    client.release();
  }
}

// ─── Join the waitlist ──────────────────────────────────────────────────────

/**
 * Add a customer to the waitlist for a session. Auto-assigns position
 * (next position after the highest existing 'waiting' entry).
 *
 * Returns:
 *   { ok: true, entry }
 *   { ok: false, code: 'session_not_found' }
 *   { ok: false, code: 'session_cancelled' }
 *   { ok: false, code: 'waitlist_disabled' }
 *   { ok: false, code: 'duplicate_waitlist' }
 *   { ok: false, code: 'session_has_capacity' }   — book, don't waitlist
 */
async function joinWaitlist({ tenantId, sessionId, customerId }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const sRes = await client.query(
      `SELECT cs.*, s.waitlist_enabled
       FROM class_sessions cs
       LEFT JOIN services s
         ON s.id = cs.service_id AND s.tenant_id = cs.tenant_id
       WHERE cs.id = $1 AND cs.tenant_id = $2
       FOR UPDATE`,
      [sessionId, tenantId]
    );
    const session = sRes.rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'session_not_found' };
    }
    if (session.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { ok: false, code: 'session_cancelled' };
    }
    if (!session.waitlist_enabled) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'waitlist_disabled' };
    }

    // Don't waitlist if there's still room — the customer should book directly.
    const seatCount = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM class_session_seats
       WHERE tenant_id = $1 AND session_id = $2 AND status IN ('confirmed','checked_in')`,
      [tenantId, sessionId]
    );
    const booked = seatCount.rows[0]?.n ?? 0;
    if (booked < Number(session.capacity)) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'session_has_capacity' };
    }

    // Compute next position
    const posRes = await client.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
       FROM class_session_waitlist
       WHERE tenant_id = $1 AND session_id = $2 AND status = 'waiting'`,
      [tenantId, sessionId]
    );
    const nextPos = posRes.rows[0]?.next_pos ?? 1;

    let entry;
    try {
      const ins = await client.query(
        `INSERT INTO class_session_waitlist
           (tenant_id, session_id, customer_id, position, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'waiting', NOW(), NOW())
         RETURNING *`,
        [tenantId, sessionId, customerId, nextPos]
      );
      entry = ins.rows[0];
    } catch (err) {
      if (err && err.code === '23505') {
        await client.query('ROLLBACK');
        return { ok: false, code: 'duplicate_waitlist' };
      }
      throw err;
    }

    await client.query('COMMIT');
    logger.info(
      { tenantId, sessionId, customerId, position: nextPos },
      'class waitlist join'
    );
    return { ok: true, entry };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    logger.error(
      { err: err.message, tenantId, sessionId, customerId },
      'joinWaitlist failed'
    );
    throw err;
  } finally {
    client.release();
  }
}

// ─── Check in ───────────────────────────────────────────────────────────────

async function checkIn({ tenantId, seatId, staffId = null }) {
  const r = await db.query(
    `UPDATE class_session_seats
     SET status = 'checked_in',
         checked_in_at = NOW(),
         checked_in_by = $1,
         updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3
       AND status = 'confirmed'
     RETURNING *`,
    [staffId, seatId, tenantId]
  );
  if (r.rows.length === 0) {
    return { ok: false, code: 'seat_not_eligible' };
  }
  return { ok: true, seat: r.rows[0] };
}

module.exports = {
  loadSession,
  loadSessionCounts,
  bookSeat,
  cancelSeat,
  joinWaitlist,
  checkIn,
};
