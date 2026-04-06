// routes/rentalAvailability.js
// ---------------------------------------------------------------------------
// Rental availability endpoints for nightly / date-range bookings.
//
// Mount in app.js:
//   app.use('/api/rental-availability', require('./routes/rentalAvailability'));
//
// Endpoints:
//   GET /api/rental-availability/check
//     → Is a specific date range available for a resource?
//
//   GET /api/rental-availability/blocked-dates
//     → All blocked dates in a month (for calendar greying)
// ---------------------------------------------------------------------------

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const {
  checkNightlyAvailability,
  getBlockedDatesForMonth,
  getNightlyPriceSummary,
  validateNightlyRange,
} = require('../utils/rentalAvailabilityEngine');

// ---------------------------------------------------------------------------
// GET /api/rental-availability/check
// Query params:
//   tenantSlug | tenantId  (one required)
//   resourceId             (required)
//   serviceId              (required — to load min/max nights + price_per_night)
//   checkIn                (YYYY-MM-DD, required)
//   checkOut               (YYYY-MM-DD, required)
//   excludeBookingId       (optional — skip this booking for edit flows)
// ---------------------------------------------------------------------------
router.get('/check', async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId: tenantIdRaw,
      resourceId: resourceIdRaw,
      serviceId: serviceIdRaw,
      checkIn,
      checkOut,
      excludeBookingId,
    } = req.query;

    if (!checkIn || !checkOut || !resourceIdRaw || !serviceIdRaw) {
      return res.status(400).json({
        error: 'Required: checkIn, checkOut, resourceId, serviceId',
      });
    }

    // Resolve tenantId
    let tenantId = tenantIdRaw ? Number(tenantIdRaw) : null;
    if (!tenantId && tenantSlug) {
      const row = await pool.query(
        'SELECT id FROM tenants WHERE slug = $1',
        [String(tenantSlug)]
      );
      if (!row.rows.length) return res.status(404).json({ error: 'Tenant not found' });
      tenantId = Number(row.rows[0].id);
    }
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug or tenantId required' });

    const resourceId = Number(resourceIdRaw);
    const serviceId  = Number(serviceIdRaw);

    if (!Number.isFinite(resourceId) || !Number.isFinite(serviceId)) {
      return res.status(400).json({ error: 'Invalid resourceId or serviceId' });
    }

    // Load service — use only columns guaranteed to exist after migration 023.
    // We do NOT reference price, price_jd, or any legacy column names.
    // currency_code comes from the tenant, not the service.
    const svcResult = await pool.query(
      `SELECT
         COALESCE(s.booking_mode, 'time_slots')  AS booking_mode,
         COALESCE(s.min_nights, 1)               AS min_nights,
         s.max_nights                             AS max_nights,
         s.price_per_night                        AS price_per_night,
         s.price_amount                           AS price_amount,
         t.currency_code                          AS currency_code
       FROM services s
       JOIN tenants  t ON t.id = s.tenant_id
       WHERE s.id = $1 AND s.tenant_id = $2`,
      [serviceId, tenantId]
    );
    if (!svcResult.rows.length) return res.status(404).json({ error: 'Service not found' });

    const svc = svcResult.rows[0];
    if (svc.booking_mode !== 'nightly') {
      return res.status(400).json({ error: 'Service is not a nightly rental service' });
    }

    // Validate range against min/max nights
    const rangeValidation = validateNightlyRange({
      checkIn,
      checkOut,
      minNights: svc.min_nights ?? 1,
      maxNights: svc.max_nights ?? null,
    });

    if (!rangeValidation.valid) {
      return res.json({
        available: false,
        reason: rangeValidation.error,
        nights: null,
        pricing: null,
      });
    }

    // Check for conflicting bookings
    const availability = await checkNightlyAvailability({
      tenantId,
      resourceId,
      checkIn,
      checkOut,
      excludeBookingId: excludeBookingId ? Number(excludeBookingId) : null,
    });

    // Compute pricing using tenant currency (not hardcoded to any currency)
    const effectivePrice = svc.price_per_night ?? svc.price_amount ?? null;
    const currencyCode   = svc.currency_code   || 'USD';

    const pricingSummary = getNightlyPriceSummary({
      checkIn,
      checkOut,
      pricePerNight: effectivePrice,
    });

    const pricing = pricingSummary
      ? { ...pricingSummary, currencyCode }
      : null;

    return res.json({
      available:    availability.available,
      nights:       rangeValidation.nights,
      pricing,
      currencyCode,
      conflicting:  availability.conflictingBookings ?? [],
    });
  } catch (err) {
    console.error('rentalAvailability/check error:', err);
    return res.status(500).json({ error: 'Availability check failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/rental-availability/blocked-dates
// Query params:
//   tenantSlug | tenantId  (one required)
//   resourceId             (required)
//   month                  (YYYY-MM, required)
// ---------------------------------------------------------------------------
router.get('/blocked-dates', async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId: tenantIdRaw,
      resourceId: resourceIdRaw,
      month,
    } = req.query;

    if (!resourceIdRaw || !month) {
      return res.status(400).json({ error: 'Required: resourceId, month (YYYY-MM)' });
    }

    if (!/^\d{4}-\d{2}$/.test(String(month))) {
      return res.status(400).json({ error: 'month must be YYYY-MM format' });
    }

    // Resolve tenantId
    let tenantId = tenantIdRaw ? Number(tenantIdRaw) : null;
    if (!tenantId && tenantSlug) {
      const row = await pool.query(
        'SELECT id FROM tenants WHERE slug = $1',
        [String(tenantSlug)]
      );
      if (!row.rows.length) return res.status(404).json({ error: 'Tenant not found' });
      tenantId = Number(row.rows[0].id);
    }
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug or tenantId required' });

    const resourceId = Number(resourceIdRaw);
    if (!Number.isFinite(resourceId)) {
      return res.status(400).json({ error: 'Invalid resourceId' });
    }

    const result = await getBlockedDatesForMonth({ tenantId, resourceId, month });

    return res.json({
      resourceId,
      month,
      ...result,
    });
  } catch (err) {
    console.error('rentalAvailability/blocked-dates error:', err);
    return res.status(500).json({ error: 'Failed to fetch blocked dates' });
  }
});

module.exports = router;
