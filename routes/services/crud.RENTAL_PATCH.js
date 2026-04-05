// routes/services/crud.RENTAL_PATCH.js
// ---------------------------------------------------------------------------
// PATCH NOTES: rental mode fields for services/crud.js
//
// Apply these changes to the existing routes/services/crud.js
// This file documents ONLY the delta — do not replace crud.js entirely.
// ---------------------------------------------------------------------------
//
// ─── A. router.post("/") — CREATE service ────────────────────────────────────
//
// 1. Add these fields to the destructured req.body:
//
//      booking_mode,        // 'time_slots' | 'nightly'
//      min_nights,
//      max_nights,
//      checkin_time,
//      checkout_time,
//      price_per_night,
//
// 2. After the existing column guards, add:
//
//      const safeBookingMode = ['time_slots', 'nightly'].includes(booking_mode)
//        ? booking_mode
//        : 'time_slots';
//
//      const safeMinNights = min_nights ? Math.max(1, Number(min_nights)) : 1;
//      const safeMaxNights = max_nights ? Number(max_nights) : null;
//
// 3. In the INSERT statement, add these columns IF the column exists
//    (use the existing svcCols.has() pattern):
//
//      const bookingModeExpr = svcCols.has('booking_mode')
//        ? `booking_mode,`
//        : '';
//      const rentalFieldsExpr = svcCols.has('min_nights')
//        ? `min_nights, max_nights, checkin_time, checkout_time, price_per_night,`
//        : '';
//
//      // ... add the actual $N params to match
//
// ─── B. router.patch("/:id") — UPDATE service ────────────────────────────────
//
// 1. Add the same fields to the destructured req.body.
//
// 2. Build SET fragments using the existing svcCols guard pattern:
//
//      if (booking_mode !== undefined && svcCols.has('booking_mode')) {
//        const safe = ['time_slots','nightly'].includes(booking_mode) ? booking_mode : 'time_slots';
//        sets.push(`booking_mode = $${params.length + 1}`);
//        params.push(safe);
//      }
//      if (min_nights !== undefined && svcCols.has('min_nights')) {
//        sets.push(`min_nights = $${params.length + 1}`);
//        params.push(Math.max(1, Number(min_nights)));
//      }
//      if (max_nights !== undefined && svcCols.has('max_nights')) {
//        sets.push(`max_nights = $${params.length + 1}`);
//        params.push(max_nights === null || max_nights === '' ? null : Number(max_nights));
//      }
//      if (checkin_time !== undefined && svcCols.has('checkin_time')) {
//        sets.push(`checkin_time = $${params.length + 1}`);
//        params.push(checkin_time);
//      }
//      if (checkout_time !== undefined && svcCols.has('checkout_time')) {
//        sets.push(`checkout_time = $${params.length + 1}`);
//        params.push(checkout_time);
//      }
//      if (price_per_night !== undefined && svcCols.has('price_per_night')) {
//        sets.push(`price_per_night = $${params.length + 1}`);
//        params.push(price_per_night === null || price_per_night === '' ? null : Number(price_per_night));
//      }
//
// ─── C. router.get("/") — GET services list ──────────────────────────────────
//
// Add these expressions to the SELECT, using the svcCols.has() guard pattern:
//
//      const bookingModeExpr = svcCols.has('booking_mode')
//        ? `COALESCE(s.booking_mode, 'time_slots') AS booking_mode`
//        : `'time_slots'::text AS booking_mode`;
//
//      const minNightsExpr = svcCols.has('min_nights')
//        ? `COALESCE(s.min_nights, 1) AS min_nights`
//        : `1::int AS min_nights`;
//
//      const maxNightsExpr = svcCols.has('max_nights')
//        ? `s.max_nights AS max_nights`
//        : `NULL::int AS max_nights`;
//
//      const checkinTimeExpr = svcCols.has('checkin_time')
//        ? `COALESCE(s.checkin_time, '15:00') AS checkin_time`
//        : `'15:00'::time AS checkin_time`;
//
//      const checkoutTimeExpr = svcCols.has('checkout_time')
//        ? `COALESCE(s.checkout_time, '11:00') AS checkout_time`
//        : `'11:00'::time AS checkout_time`;
//
//      const pricePerNightExpr = svcCols.has('price_per_night')
//        ? `s.price_per_night AS price_per_night`
//        : `NULL::numeric AS price_per_night`;
//
// ─── D. bookings POST — create nightly booking ───────────────────────────────
//
// In routes/bookings.js (or bookings/create.js), when service.booking_mode = 'nightly':
//
//      // checkIn and checkOut come from req.body as YYYY-MM-DD strings
//      const checkIn  = req.body.checkin_date;
//      const checkOut = req.body.checkout_date;
//
//      // Convert to timestamps (midnight UTC)
//      const startTime = new Date(`${checkIn}T00:00:00Z`);
//      const endTime   = new Date(`${checkOut}T00:00:00Z`);
//
//      const nights = Math.round((endTime - startTime) / (1000*60*60*24));
//
//      // Run nightly availability check BEFORE inserting
//      const avail = await checkNightlyAvailability({ tenantId, resourceId, checkIn, checkOut });
//      if (!avail.available) {
//        return res.status(409).json({ error: 'Selected dates are not available', conflicts: avail.conflictingBookings });
//      }
//
//      // INSERT with booking_mode, checkin_date, checkout_date, nights_count
//      // duration_minutes = nights * 60 * 24 (or a sentinel value like 0)
//
// ---------------------------------------------------------------------------
// END OF PATCH NOTES
// ---------------------------------------------------------------------------

// This file is documentation only — no executable code needed.
// Implement the changes above directly in routes/services/crud.js
// and in your bookings creation route.

module.exports = {};
