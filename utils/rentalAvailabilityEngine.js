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
// Returns:
//   { available: true }
//   { available: false, conflictingBookings: [{id, checkin_date, checkout_date, status}] }
// ---------------------------------------------------------------------------
async function checkNightlyAvailability({
  tenantId,
  resourceId,
  checkIn,   // YYYY-MM-DD
  checkOut,  // YYYY-MM-DD  (exclusive end — day guest departs)
  excludeBookingId = null, // for edit scenarios
}) {
  if (!tenantId || !resourceId || !checkIn || !checkOut) {
    throw new Error('tenantId, resourceId, checkIn, checkOut are all required');
  }

  const params = [tenantId, resourceId, checkIn, checkOut];
  let excludeClause = '';
  if (excludeBookingId) {
    params.push(excludeBookingId);
    excludeClause = `AND b.id != $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT b.id, b.checkin_date, b.checkout_date, b.status
     FROM bookings b
     WHERE b.tenant_id        = $1
       AND b.resource_id      = $2
       AND b.booking_mode     = 'nightly'
       AND b.deleted_at IS NULL
       AND b.status           NOT IN ('cancelled')
       AND b.checkin_date     < $4::date
       AND b.checkout_date    > $3::date
       ${excludeClause}
     ORDER BY b.checkin_date`,
    params
  );

  if (rows.length === 0) return { available: true, conflictingBookings: [] };
  return { available: false, conflictingBookings: rows };
}

// ---------------------------------------------------------------------------
// getBlockedDatesForMonth
// Returns all date strings (YYYY-MM-DD) that are occupied in a given month.
// Used to disable past dates in the booking calendar.
//
// month = YYYY-MM (e.g. "2026-04")
// ---------------------------------------------------------------------------
async function getBlockedDatesForMonth({ tenantId, resourceId, month }) {
  if (!tenantId || !resourceId || !month) {
    throw new Error('tenantId, resourceId, month are all required');
  }

  // Compute month window
  const [year, mon] = month.split('-').map(Number);
  const firstDay = `${year}-${String(mon).padStart(2, '0')}-01`;
  const lastDay  = new Date(year, mon, 0); // day 0 of next month = last day of this month
  const lastDayStr = `${year}-${String(mon).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;

  // Fetch all nightly bookings that overlap this month
  const { rows } = await pool.query(
    `SELECT checkin_date, checkout_date
     FROM bookings
     WHERE tenant_id     = $1
       AND resource_id   = $2
       AND booking_mode  = 'nightly'
       AND deleted_at    IS NULL
       AND status        NOT IN ('cancelled')
       AND checkin_date  <= $4::date
       AND checkout_date >  $3::date
     ORDER BY checkin_date`,
    [tenantId, resourceId, firstDay, lastDayStr]
  );

  // Expand each booking into individual blocked dates
  const blocked = new Set();

  for (const row of rows) {
    const ci = new Date(`${row.checkin_date}T00:00:00Z`);
    const co = new Date(`${row.checkout_date}T00:00:00Z`);

    // Occupy nights: [checkin, checkout)
    const cursor = new Date(ci);
    while (cursor < co) {
      const iso = cursor.toISOString().slice(0, 10);
      blocked.add(iso);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  return { blockedDates: Array.from(blocked).sort() };
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
