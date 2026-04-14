'use strict';

// routes/guestPortal.js
// PR-GUEST-1: Public read-only guest portal for rental reservations.
//
// Mount in app.js:
//   app.use('/api/guest', publicApiLimiter, require('./routes/guestPortal'));
//
// Endpoint:
//   GET /api/guest/reservation/:bookingCode
//     — No auth required.
//     — Returns booking summary: property, dates, status, payment links, contract.
//     — Never exposes customer phone/email (privacy) or tenant payment credentials.
//     — Designed to be linked from WhatsApp confirmation messages.
//
// Security model:
//   - booking_code is a random 8-char alphanumeric (migration 026) — not guessable.
//   - Returns only fields safe to show publicly:
//       booking details, resource name, tenant name, payment status.
//   - Contract URL is included only if one is attached (owner uploaded it).

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const logger  = require('../utils/logger');

// ---------------------------------------------------------------------------
// GET /api/guest/reservation/:bookingCode
// ---------------------------------------------------------------------------
router.get('/reservation/:bookingCode', async (req, res) => {
  try {
    const code = String(req.params.bookingCode || '').trim().toUpperCase();
    if (!code || code.length < 4) {
      return res.status(400).json({ error: 'Invalid booking code.' });
    }

    const { rows } = await db.query(
      `SELECT
         -- Booking core
         b.id              AS booking_id,
         b.booking_code,
         b.status          AS booking_status,
         b.created_at,

         -- Customer (name only — no contact details publicly)
         b.customer_name,

         -- Dates & guests
         b.checkin_date,
         b.checkout_date,
         b.nights_count,
         b.guests_count,
         b.start_time,          -- timeslot bookings
         b.end_time,

         -- Financials
         b.price_amount,
         b.charge_amount,
         b.currency_code,
         b.subtotal_amount,
         b.total_amount,

         -- Contract
         b.contract_url,
         b.contract_name,

         -- Resource (unit/room/service)
         r.name            AS resource_name,
         r.building_name,

         -- Service name
         s.name            AS service_name,

         -- Tenant (public-safe fields only)
         t.name            AS tenant_name,
         t.slug            AS tenant_slug,

         -- Payment links (most recent pending/partial, if any)
         (SELECT json_agg(json_build_object(
             'token',            pl.token,
             'status',           pl.status,
             'amount_requested', pl.amount_requested,
             'amount_paid',      pl.amount_paid,
             'currency_code',    pl.currency_code,
             'expires_at',       pl.expires_at
           ) ORDER BY pl.created_at DESC)
          FROM rental_payment_links pl
          WHERE pl.booking_id = b.id
            AND pl.status IN ('pending','partial','paid')
         ) AS payment_links

       FROM bookings b
       JOIN tenants  t ON t.id = b.tenant_id
       LEFT JOIN resources r ON r.id = b.resource_id
       LEFT JOIN services  s ON s.id = b.service_id
       WHERE b.booking_code = $1
         AND b.deleted_at IS NULL
       LIMIT 1`,
      [code]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Reservation not found. Please check your booking code.' });
    }

    const b = rows[0];

    // Determine a friendly status label
    const statusMap = {
      pending:           { label: 'Pending confirmation', tone: 'warning' },
      confirmed:         { label: 'Confirmed',             tone: 'success' },
      checked_in:        { label: 'Checked in',            tone: 'success' },
      completed:         { label: 'Completed',             tone: 'neutral' },
      cancelled:         { label: 'Cancelled',             tone: 'danger'  },
      no_show:           { label: 'No-show',               tone: 'danger'  },
    };
    const statusInfo = statusMap[b.booking_status] || { label: b.booking_status, tone: 'neutral' };

    // Build payment summary
    const paymentLinks = Array.isArray(b.payment_links) ? b.payment_links : [];
    const totalDue  = Number(b.charge_amount || b.price_amount || 0);
    const totalPaid = paymentLinks.reduce((sum, pl) => sum + Number(pl.amount_paid || 0), 0);
    const balance   = Math.max(0, totalDue - totalPaid);
    const isPaid    = balance <= 0 || paymentLinks.some(pl => pl.status === 'paid');

    return res.json({
      ok: true,
      reservation: {
        bookingCode:    b.booking_code,
        bookingId:      b.booking_id,
        status:         b.booking_status,
        statusLabel:    statusInfo.label,
        statusTone:     statusInfo.tone,
        createdAt:      b.created_at,

        // Guest
        customerName:   b.customer_name,

        // Property / service
        resourceName:   b.resource_name || null,
        buildingName:   b.building_name || null,
        serviceName:    b.service_name  || null,
        tenantName:     b.tenant_name,
        tenantSlug:     b.tenant_slug,

        // Dates
        checkinDate:    b.checkin_date  ? String(b.checkin_date).slice(0, 10)  : null,
        checkoutDate:   b.checkout_date ? String(b.checkout_date).slice(0, 10) : null,
        nightsCount:    b.nights_count  || null,
        guestsCount:    b.guests_count  || null,
        startTime:      b.start_time    || null,
        endTime:        b.end_time      || null,

        // Financials
        totalAmount:    String(b.total_amount || b.charge_amount || b.price_amount || '0'),
        totalPaid:      String(totalPaid),
        balance:        String(balance),
        currency:       b.currency_code || 'JOD',
        isPaid,

        // Contract
        contractUrl:    b.contract_url  || null,
        contractName:   b.contract_name || null,

        // Payment links
        paymentLinks: paymentLinks.map(pl => ({
          token:           pl.token,
          status:          pl.status,
          amountRequested: String(pl.amount_requested || '0'),
          amountPaid:      String(pl.amount_paid      || '0'),
          currency:        pl.currency_code,
          expiresAt:       pl.expires_at || null,
          paymentUrl:      `${process.env.BOOKING_FRONTEND_URL || 'https://flexrz.com'}/pay/${pl.token}`,
        })),
      },
    });
  } catch (err) {
    logger.error({ err }, 'GET /guest/reservation/:code error');
    return res.status(500).json({ error: 'Failed to load reservation.' });
  }
});

module.exports = router;
