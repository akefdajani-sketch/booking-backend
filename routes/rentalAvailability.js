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
//
//   GET /api/rental-availability/blocked-dates/batch  ← FINAL-CONTRACT-FIX
//     → All blocked dates across multiple months in ONE round trip.
//       Replaces 12 parallel single-month calls from CreateContractModal.
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

// Rates engine — apply tenant rate rules to nightly check-in date
let computeRateForBookingLike;
try {
  ({ computeRateForBookingLike } = require('../utils/ratesEngine'));
} catch (_) {
  computeRateForBookingLike = null;
}

// ---------------------------------------------------------------------------
// GET /api/rental-availability/check
// (unchanged — full body preserved)
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

    const svcResult = await pool.query(
      `SELECT s.booking_mode, COALESCE(s.min_nights,1) AS min_nights, s.max_nights,
              s.price_per_night, s.price_amount,
              t.currency_code
       FROM services s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.id = $1 AND s.tenant_id = $2`,
      [serviceId, tenantId]
    );
    if (!svcResult.rows.length) return res.status(404).json({ error: 'Service not found' });

    const svc = svcResult.rows[0];
    if (svc.booking_mode !== 'nightly') {
      return res.status(400).json({ error: 'Service is not a nightly rental service' });
    }

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

    const availability = await checkNightlyAvailability({
      tenantId,
      resourceId,
      checkIn,
      checkOut,
      excludeBookingId: excludeBookingId ? Number(excludeBookingId) : null,
    });

    const rawAmount = svc.price_amount != null ? Number(svc.price_amount) : null;
    const rawPerNight = svc.price_per_night != null ? Number(svc.price_per_night) : null;
    const basePricePerNight = rawAmount ?? rawPerNight ?? 0;
    const currencyCode      = svc.currency_code || 'JOD';

    let effectivePrice = basePricePerNight;
    let rateMatched = false;
    if (computeRateForBookingLike) {
      try {
        const nightsCount    = rangeValidation.nights || 1;
        const checkInDate    = new Date(`${checkIn}T12:00:00Z`);
        const rateResult     = await computeRateForBookingLike({
          tenantId,
          serviceId,
          staffId:    null,
          resourceId,
          start:           checkInDate,
          durationMinutes: nightsCount * 1440,
          basePriceAmount: basePricePerNight,
          serviceSlotMinutes: 1440,
        });
        if (rateResult?.adjusted_price_amount != null) {
          const totalAdjusted = Number(rateResult.adjusted_price_amount);
          effectivePrice = nightsCount > 0 ? totalAdjusted / nightsCount : totalAdjusted;
          rateMatched = true;
        }
      } catch (rateErr) {
        console.warn('rentalAvailability: rate engine error (non-fatal):', rateErr?.message || rateErr);
      }
    }

    const hasBasePrice = basePricePerNight > 0;
    const priceUnavailable = !rateMatched && !hasBasePrice;

    const pricingSummary = priceUnavailable
      ? null
      : getNightlyPriceSummary({ checkIn, checkOut, pricePerNight: effectivePrice });
    const pricing = pricingSummary ? { ...pricingSummary, currencyCode } : null;

    return res.json({
      available:   availability.available,
      nights:      rangeValidation.nights,
      pricing,
      priceUnavailable,
      rateMatched,
      currencyCode,
      conflicting: availability.conflictingBookings ?? [],
    });
  } catch (err) {
    console.error('rentalAvailability/check error:', err);
    return res.status(500).json({ error: 'Availability check failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/rental-availability/blocked-dates
// (single month — preserved for backward compatibility)
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

// ---------------------------------------------------------------------------
// GET /api/rental-availability/blocked-dates/batch    ← FINAL-CONTRACT-FIX
//
// Query params:
//   tenantSlug | tenantId   (one required)
//   resourceId              (required)
//   months                  (comma-separated YYYY-MM list, 1..24, required)
//
// Response:
//   {
//     resourceId,
//     months: {
//       "YYYY-MM": { blockedDates: ["YYYY-MM-DD",...] },
//       ...
//     }
//   }
//
// Replaces N parallel single-month calls. CreateContractModal previously
// fired 12 in parallel on every resource change; with the batch endpoint
// it fires 1.
// ---------------------------------------------------------------------------
router.get('/blocked-dates/batch', async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId: tenantIdRaw,
      resourceId: resourceIdRaw,
      months: monthsRaw,
    } = req.query;

    if (!resourceIdRaw || !monthsRaw) {
      return res.status(400).json({ error: 'Required: resourceId, months (comma-separated YYYY-MM)' });
    }

    const months = String(monthsRaw)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (months.length === 0) {
      return res.status(400).json({ error: 'months must contain at least one YYYY-MM value' });
    }
    if (months.length > 24) {
      return res.status(400).json({ error: 'months may not exceed 24 entries per request' });
    }
    for (const m of months) {
      if (!/^\d{4}-\d{2}$/.test(m)) {
        return res.status(400).json({ error: `Invalid month "${m}" — must be YYYY-MM` });
      }
    }
    // Dedupe (preserves order of first occurrence).
    const seen = new Set();
    const uniqueMonths = months.filter(m => {
      if (seen.has(m)) return false;
      seen.add(m); return true;
    });

    // Resolve tenantId ONCE (vs N times in the per-month flow).
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

    // Fetch all months in parallel — but on the SERVER side, with a single
    // tenantId resolution and a shared pg connection pool. Server-side
    // parallelism is much cheaper than 12 client→server round trips.
    const results = await Promise.all(
      uniqueMonths.map(month =>
        getBlockedDatesForMonth({ tenantId, resourceId, month })
          .then(r => ({ month, blockedDates: Array.isArray(r?.blockedDates) ? r.blockedDates : [] }))
          .catch(err => {
            console.error(`rentalAvailability/blocked-dates/batch [${month}]:`, err);
            return { month, blockedDates: [] };
          })
      )
    );

    const monthsMap = {};
    for (const r of results) {
      monthsMap[r.month] = { blockedDates: r.blockedDates };
    }

    return res.json({
      resourceId,
      months: monthsMap,
    });
  } catch (err) {
    console.error('rentalAvailability/blocked-dates/batch error:', err);
    return res.status(500).json({ error: 'Failed to fetch blocked dates batch' });
  }
});

module.exports = router;
