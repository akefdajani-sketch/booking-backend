// utils/rentalAvailabilityEngine.js
// ---------------------------------------------------------------------------
// Nightly availability engine for property-rental style bookings.
//
// Unlike the time-slot engine (availabilityEngine.js) which generates
// HH:MM slots for a single day, this engine:
//   - Takes a date range (checkIn, checkOut)
//   - Checks whether the requested resource is free for ALL nights
//   - Returns blocked dates for a given month (for calendar rendering)
//   - Is intentionally simple — no slot arithmetic needed
//
// Date convention:
//   checkIn  = first night (guest arrives)
//   checkOut = last night + 1 (guest departs, room free this day)
//   A booking "occupies" nights: checkIn .. checkOut - 1 (exclusive end)
//
// Overlap rule (standard half-open interval):
//   Two bookings A and B overlap when:
//     A.checkin_date < B.checkout_date  AND  A.checkout_date > B.checkin_date
// ---------------------------------------------------------------------------

const pool = require('../db');

// ---------------------------------------------------------------------------
// checkNightlyAvailability
// Checks whether a resource is available for [checkIn, checkOut).
//
// Handles two booking formats:
//   1. booking_mode = 'nightly'   → uses checkin_date / checkout_date columns
//   2. booking_mode = 'time_slots' (or NULL, legacy) → derives date from start_time
//      (start_time is stored as midnight UTC on the check-in day)
//
// Returns:
//   { available: true }
//   { available: false, conflictingBookings: [...] }
// ---------------------------------------------------------------------------
async function checkNightlyAvailability({
  tenantId,
  resourceId,
  checkIn,
  checkOut,
  excludeBookingId = null,
}) {
  if (!tenantId || !resourceId || !checkIn || !checkOut) {
    throw new Error('tenantId, resourceId, checkIn, checkOut are all required');
  }

  // ── Long-term lease guard ────────────────────────────────────────────────
  // Blocks short-term availability for units under an active long-term lease.
  // Timeslot engine is completely unaffected — this only runs for nightly checks.
  try {
    const unitRes = await pool.query(
      `SELECT rental_type, lease_start, lease_end, auto_release_on_expiry
       FROM resources WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [resourceId, tenantId]
    );
    if (unitRes.rows.length) {
      const unit  = unitRes.rows[0];
      const today = new Date().toISOString().slice(0, 10);

      // Under lease when: long_term, OR flexible with lease not yet expired
      const isUnderLease =
        unit.rental_type === 'long_term' ||
        (unit.rental_type === 'flexible' &&
          unit.lease_end &&
          String(unit.lease_end).slice(0, 10) >= today);

      if (isUnderLease) {
        if (unit.lease_start && unit.lease_end) {
          const leaseStart = String(unit.lease_start).slice(0, 10);
          const leaseEnd   = String(unit.lease_end).slice(0, 10);
          // Half-open interval overlap
          if (checkIn < leaseEnd && checkOut > leaseStart) {
            return {
              available: false,
              conflictingBookings: [],
              reason: 'This unit is under a long-term lease and is not available for short-term bookings during this period.',
            };
          }
          // Request is outside lease window — fall through to normal check
        } else {
          return {
            available: false,
            conflictingBookings: [],
            reason: 'This unit is not available for short-term bookings.',
          };
        }
      }
    }
  } catch (leaseErr) {
    console.warn('rentalAvailabilityEngine: lease guard failed (non-fatal):', leaseErr?.message);
  }
  // ── End lease guard ──────────────────────────────────────────────────────

  const params = [tenantId, resourceId, checkIn, checkOut];
  let excludeClause = '';
  if (excludeBookingId) {
    params.push(excludeBookingId);
    excludeClause = `AND b.id != $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT b.id, b.checkin_date, b.checkout_date, b.start_time, b.booking_mode, b.status
     FROM bookings b
     WHERE b.tenant_id    = $1
       AND b.resource_id  = $2
       AND b.deleted_at   IS NULL
       AND b.status       NOT IN ('cancelled')
       AND (
         -- Nightly bookings: standard half-open interval overlap
         (b.booking_mode = 'nightly'
          AND b.checkin_date  IS NOT NULL
          AND b.checkout_date IS NOT NULL
          AND b.checkin_date  < $4::date
          AND b.checkout_date > $3::date)
         OR
         -- Timeslot / legacy bookings: start_time falls on a night within the requested range.
         -- start_time is stored as midnight UTC on the check-in day (UTC+3 = 3:00 AM Amman).
         (COALESCE(b.booking_mode, 'time_slots') != 'nightly'
          AND b.start_time IS NOT NULL
          AND (b.start_time AT TIME ZONE 'UTC')::date >= $3::date
          AND (b.start_time AT TIME ZONE 'UTC')::date <  $4::date)
       )
       ${excludeClause}
     ORDER BY b.checkin_date, b.start_time`,
    params
  );

  if (rows.length === 0) return { available: true, conflictingBookings: [] };
  return { available: false, conflictingBookings: rows };
}

// ---------------------------------------------------------------------------
// getBlockedDatesForMonth
// Returns all blocked date strings (YYYY-MM-DD) for a resource in a given month.
// Handles two booking formats:
//   1. booking_mode = 'nightly'    → expands checkin_date..checkout_date range
//   2. booking_mode = 'time_slots' (or NULL, legacy/manual) → blocks the date of start_time
//      (start_time is stored as midnight UTC = 3:00 AM Amman for same-day bookings)
//
// month = YYYY-MM
// ---------------------------------------------------------------------------
async function getBlockedDatesForMonth({ tenantId, resourceId, month }) {
  if (!tenantId || !resourceId || !month) {
    throw new Error('tenantId, resourceId, month are all required');
  }

  const [year, mon] = month.split('-').map(Number);
  const firstDay   = `${year}-${String(mon).padStart(2, '0')}-01`;
  const lastDay    = new Date(year, mon, 0);
  const lastDayStr = `${year}-${String(mon).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;

  // ── Long-term lease: block entire lease period within this month ──────────
  try {
    const unitRes = await pool.query(
      `SELECT rental_type, lease_start, lease_end FROM resources WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [resourceId, tenantId]
    );
    if (unitRes.rows.length) {
      const unit  = unitRes.rows[0];
      const today = new Date().toISOString().slice(0, 10);
      const isUnderLease =
        unit.rental_type === 'long_term' ||
        (unit.rental_type === 'flexible' && unit.lease_end && String(unit.lease_end).slice(0, 10) >= today);

      if (isUnderLease && unit.lease_start && unit.lease_end) {
        const leaseStart = String(unit.lease_start).slice(0, 10);
        const leaseEnd   = String(unit.lease_end).slice(0, 10);
        const leaseBlocked = new Set();
        const cursor = new Date(`${firstDay}T00:00:00Z`);
        const end    = new Date(`${lastDayStr}T00:00:00Z`);
        while (cursor <= end) {
          const d = cursor.toISOString().slice(0, 10);
          if (d >= leaseStart && d < leaseEnd) leaseBlocked.add(d);
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        if (unit.rental_type === 'long_term') {
          // Pure long-term: return only lease-blocked dates, skip booking query
          return { blockedDates: Array.from(leaseBlocked).sort() };
        }
        // Flexible: merge lease-blocked with booking-blocked
        if (leaseBlocked.size > 0) {
          const bookingBlocked = await _getBookingBlockedDates(tenantId, resourceId, firstDay, lastDayStr);
          return { blockedDates: Array.from(new Set([...leaseBlocked, ...bookingBlocked])).sort() };
        }
      } else if (isUnderLease && unit.rental_type === 'long_term') {
        // long_term with no dates = block every day this month
        const all = []; const c = new Date(`${firstDay}T00:00:00Z`); const e = new Date(`${lastDayStr}T00:00:00Z`);
        while (c <= e) { all.push(c.toISOString().slice(0, 10)); c.setUTCDate(c.getUTCDate() + 1); }
        return { blockedDates: all };
      }
    }
  } catch (leaseErr) {
    console.warn('getBlockedDatesForMonth: lease guard failed (non-fatal):', leaseErr?.message);
  }
  // ── End lease guard — fall through to normal booking-based blocking ───────

  const blocked = await _getBookingBlockedDates(tenantId, resourceId, firstDay, lastDayStr);
  return { blockedDates: Array.from(blocked).sort() };
}

// Internal: booking-based blocked dates (extracted so lease path can reuse it)
async function _getBookingBlockedDates(tenantId, resourceId, firstDay, lastDayStr) {
  // Fetch all active bookings for this resource that overlap this month.
  // Two cases handled in a single query:
  //   - Nightly: date-range overlap with checkin_date/checkout_date
  //   - Timeslot/legacy: start_time (UTC) falls within the month
  const { rows } = await pool.query(
    `SELECT booking_mode, checkin_date, checkout_date, start_time
     FROM bookings
     WHERE tenant_id    = $1
       AND resource_id  = $2
       AND deleted_at   IS NULL
       AND status       NOT IN ('cancelled')
       AND (
         -- Nightly bookings with explicit date range
         (booking_mode = 'nightly'
          AND checkin_date  IS NOT NULL
          AND checkout_date IS NOT NULL
          AND checkin_date  <= $4::date
          AND checkout_date >  $3::date)
         OR
         -- Timeslot / legacy bookings: derive blocked date from start_time (stored UTC)
         (COALESCE(booking_mode, 'time_slots') != 'nightly'
          AND start_time IS NOT NULL
          AND (start_time AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date)
       )
     ORDER BY checkin_date, start_time`,
    [tenantId, resourceId, firstDay, lastDayStr]
  );

  const blocked = new Set();

  for (const row of rows) {
    if (row.booking_mode === 'nightly' && row.checkin_date && row.checkout_date) {
      // node-postgres returns DATE columns as JavaScript Date objects (full ISO strings
      // like "2026-04-15T00:00:00.000Z"). Concatenating "T00:00:00Z" onto that produces
      // "2026-04-15T00:00:00.000ZT00:00:00Z" → Invalid Date → while loop never runs.
      // Fix: extract just the YYYY-MM-DD portion regardless of what node-postgres returns.
      const ciStr = (row.checkin_date instanceof Date)
        ? row.checkin_date.toISOString().slice(0, 10)
        : String(row.checkin_date).slice(0, 10);
      const coStr = (row.checkout_date instanceof Date)
        ? row.checkout_date.toISOString().slice(0, 10)
        : String(row.checkout_date).slice(0, 10);

      const ci     = new Date(`${ciStr}T00:00:00Z`);
      const co     = new Date(`${coStr}T00:00:00Z`);
      const cursor = new Date(ci);
      while (cursor < co) {
        blocked.add(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    } else if (row.start_time) {
      // Timeslot / legacy: block the UTC date of the start_time
      const d = new Date(row.start_time);
      blocked.add(d.toISOString().slice(0, 10));
    }
  }

  return blocked; // Returns Set<string> for internal callers
}

// ---------------------------------------------------------------------------
// getNightlyPriceSummary
// Calculates total price for a nightly booking.
// Returns null if pricing cannot be determined.
// ---------------------------------------------------------------------------
function getNightlyPriceSummary({ checkIn, checkOut, pricePerNight }) {
  if (!checkIn || !checkOut || pricePerNight == null) return null;

  const ci = new Date(`${checkIn}T00:00:00Z`);
  const co = new Date(`${checkOut}T00:00:00Z`);
  const nights = Math.round((co - ci) / (1000 * 60 * 60 * 24));

  if (nights <= 0) return null;

  return {
    nights,
    pricePerNight: Number(pricePerNight),
    totalPrice: nights * Number(pricePerNight),
  };
}

// ---------------------------------------------------------------------------
// validateNightlyRange
// Returns { valid: true } or { valid: false, error: string }
// ---------------------------------------------------------------------------
function validateNightlyRange({ checkIn, checkOut, minNights = 1, maxNights = null }) {
  if (!checkIn || !checkOut) return { valid: false, error: 'Check-in and check-out dates are required.' };

  const ci = new Date(`${checkIn}T00:00:00Z`);
  const co = new Date(`${checkOut}T00:00:00Z`);

  if (isNaN(ci.getTime()) || isNaN(co.getTime())) return { valid: false, error: 'Invalid dates.' };
  if (co <= ci) return { valid: false, error: 'Check-out must be after check-in.' };

  const nights = Math.round((co - ci) / (1000 * 60 * 60 * 24));

  if (nights < minNights) {
    return { valid: false, error: `Minimum stay is ${minNights} night${minNights !== 1 ? 's' : ''}.` };
  }
  if (maxNights && nights > maxNights) {
    return { valid: false, error: `Maximum stay is ${maxNights} night${maxNights !== 1 ? 's' : ''}.` };
  }

  return { valid: true, nights };
}

module.exports = {
  checkNightlyAvailability,
  getBlockedDatesForMonth,
  getNightlyPriceSummary,
  validateNightlyRange,
};
