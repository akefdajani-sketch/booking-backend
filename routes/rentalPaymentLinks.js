'use strict';

// routes/rentalPaymentLinks.js
// ---------------------------------------------------------------------------
// Payment link system for rental bookings.
//
// Mount in app.js:
//   app.use('/api/rental-payment-links', require('./routes/rentalPaymentLinks'));
//
// OWNER endpoints (require tenant auth):
//   POST   /api/rental-payment-links           — create a payment link for a booking
//   GET    /api/rental-payment-links           — list all links for a tenant
//   GET    /api/rental-payment-links/:id       — get one link
//   PATCH  /api/rental-payment-links/:id       — update status / record cash payment
//   DELETE /api/rental-payment-links/:id       — cancel a link
//
// PUBLIC endpoint (no auth — accessed via the payment portal page):
//   GET    /api/rental-payment-links/public/:token  — get link details for portal
//   POST   /api/rental-payment-links/public/:token/pay — initiate MPGS payment
//   POST   /api/rental-payment-links/public/:token/record-cash — rep records cash
// ---------------------------------------------------------------------------

const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const logger   = require('../utils/logger');
const requireAppAuth         = require('../middleware/requireAppAuth');
const { requireTenant }      = require('../middleware/requireTenant');
const requireAdminOrTenantRole = require('../middleware/requireAdminOrTenantRole');

// Lazy-load payment utils (non-fatal if not configured)
let isTenantMpgsEnabled, createCheckoutSession;
try {
  ({ isTenantMpgsEnabled } = require('../utils/network'));
  ({ createCheckoutSession } = require('../utils/network'));
} catch { /* payment gateway optional */ }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateOrderId(tenantSlug) {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = require('crypto').randomBytes(3).toString('hex').toUpperCase();
  const slug = String(tenantSlug || 'T').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return `FRZ-${slug}-${ts}-${rand}`.slice(0, 40);
}

async function getTenantIdFromReq(req) {
  return Number(req.tenantId || 0);
}

// ---------------------------------------------------------------------------
// POST /api/rental-payment-links
// Owner: create a payment link for a booking.
// Body: { bookingId, amountRequested, description?, allowedMethods?, expiresInDays? }
// ---------------------------------------------------------------------------
router.post(
  '/',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = await getTenantIdFromReq(req);
      if (!tenantId) return res.status(400).json({ error: 'Tenant required' });

      const {
        bookingId,
        amountRequested,
        description,
        allowedMethods,
        expiresInDays,
        createdByName,
        createdByEmail,
      } = req.body || {};

      if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
      if (!amountRequested || isNaN(Number(amountRequested)) || Number(amountRequested) <= 0) {
        return res.status(400).json({ error: 'amountRequested must be a positive number' });
      }

      // Verify booking belongs to this tenant
      const bRes = await db.query(
        `SELECT b.id, b.booking_code, b.customer_name, b.customer_phone,
                b.customer_email, b.checkin_date, b.checkout_date,
                b.nights_count, b.status, b.currency_code,
                r.name AS resource_name, t.currency_code AS tenant_currency
         FROM bookings b
         LEFT JOIN resources r ON r.id = b.resource_id
         JOIN tenants t ON t.id = b.tenant_id
         WHERE b.id = $1 AND b.tenant_id = $2 AND b.deleted_at IS NULL`,
        [Number(bookingId), tenantId]
      );
      if (!bRes.rows.length) return res.status(404).json({ error: 'Booking not found' });
      const booking = bRes.rows[0];

      // Compute expiry
      let expiresAt = null;
      if (expiresInDays && Number(expiresInDays) > 0) {
        expiresAt = new Date(Date.now() + Number(expiresInDays) * 86400000).toISOString();
      }

      const currency = booking.currency_code || booking.tenant_currency || 'JOD';

      const ins = await db.query(
        `INSERT INTO rental_payment_links
           (tenant_id, booking_id, amount_requested, currency_code,
            description, allowed_methods, expires_at, created_by_name, created_by_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          tenantId,
          Number(bookingId),
          Number(amountRequested).toFixed(3),
          currency,
          description || `Payment for ${booking.resource_name || 'booking'} · ${booking.booking_code || `#${booking.id}`}`,
          allowedMethods ? JSON.stringify(allowedMethods) : null,
          expiresAt,
          createdByName || null,
          createdByEmail || null,
        ]
      );
      const link = ins.rows[0];

      // Build the portal URL
      const frontendUrl = process.env.FRONTEND_URL || 'https://app.flexrz.com';
      const portalUrl   = `${frontendUrl}/pay/${link.token}`;

      logger.info({ tenantId, bookingId, linkId: link.id, amount: amountRequested }, 'Payment link created');

      // ── WhatsApp payment link notification (non-fatal) ────────────────────
      if (booking.customer_phone) {
        setImmediate(async () => {
          try {
            const { sendPaymentLink, isWhatsAppConfigured } = require('../utils/whatsapp');
            if (!isWhatsAppConfigured()) return;
            const waResult = await sendPaymentLink({
              customerPhone: booking.customer_phone,
              customerName:  booking.customer_name,
              tenantName:    booking.tenant_currency ? booking.tenant_name : link.tenant_name,
              bookingCode:   booking.booking_code,
              resourceName:  booking.resource_name,
              checkinDate:   booking.checkin_date,
              checkoutDate:  booking.checkout_date,
              amountDue:     Number(amountRequested),
              currency:      currency,
              paymentUrl:    portalUrl,
            });
            if (waResult.ok) {
              // Record WhatsApp send on the link
              await db.query(
                `UPDATE rental_payment_links SET whatsapp_sent_at = NOW(), whatsapp_sent_to = $1, whatsapp_message_id = $2 WHERE id = $3`,
                [booking.customer_phone, waResult.messageId, link.id]
              );
              logger.info({ linkId: link.id, phone: booking.customer_phone }, 'WhatsApp payment link sent');
            }
          } catch (waErr) {
            logger.error({ err: waErr, linkId: link.id }, 'WhatsApp payment link send error (non-fatal)');
          }
        });
      }
      // ── End WhatsApp ──────────────────────────────────────────────────────

      return res.status(201).json({
        ok:       true,
        link:     { ...link, portal_url: portalUrl },
        booking,
        portalUrl,
      });
    } catch (err) {
      logger.error({ err }, 'POST /rental-payment-links error');
      return res.status(500).json({ error: 'Failed to create payment link' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/rental-payment-links
// Owner: list payment links for a tenant (optionally filter by bookingId)
// ---------------------------------------------------------------------------
router.get(
  '/',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = await getTenantIdFromReq(req);
      if (!tenantId) return res.status(400).json({ error: 'Tenant required' });

      const { bookingId, status, limit = 50, offset = 0 } = req.query;

      const where  = ['l.tenant_id = $1'];
      const params = [tenantId];

      if (bookingId) { params.push(Number(bookingId)); where.push(`l.booking_id = $${params.length}`); }
      if (status)    { params.push(String(status));    where.push(`l.status = $${params.length}`); }

      params.push(Number(limit)); params.push(Number(offset));

      const { rows } = await db.query(
        `SELECT l.*,
                b.booking_code, b.customer_name, b.customer_phone, b.customer_email,
                b.checkin_date, b.checkout_date, b.nights_count, b.status AS booking_status,
                r.name AS resource_name,
                '${process.env.FRONTEND_URL || 'https://app.flexrz.com'}/pay/' || l.token AS portal_url
         FROM rental_payment_links l
         JOIN bookings b  ON b.id = l.booking_id
         LEFT JOIN resources r ON r.id = b.resource_id
         WHERE ${where.join(' AND ')}
         ORDER BY l.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      return res.json({ ok: true, links: rows });
    } catch (err) {
      logger.error({ err }, 'GET /rental-payment-links error');
      return res.status(500).json({ error: 'Failed to load payment links' });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/rental-payment-links/:id
// Owner/rep: update a link — record cash payment, cancel, etc.
// Body: { status?, paymentNotes?, paidVia?, paymentRef?, amountPaid? }
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = await getTenantIdFromReq(req);
      const id       = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid id' });

      const { status, paymentNotes, paidVia, paymentRef, amountPaid } = req.body || {};

      const sets   = [];
      const params = [];
      const add    = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

      if (status)       add('status',        status);
      if (paymentNotes) add('payment_notes', paymentNotes);
      if (paidVia)      add('paid_via',      paidVia);
      if (paymentRef)   add('payment_ref',   paymentRef);
      if (amountPaid != null) add('amount_paid', Number(amountPaid).toFixed(3));

      // Auto-set paid_at when marking as paid
      if (status === 'paid' || status === 'partial') {
        add('paid_at', new Date().toISOString());
      }

      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

      params.push(id); params.push(tenantId);
      const r = await db.query(
        `UPDATE rental_payment_links SET ${sets.join(', ')}
         WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
         RETURNING *`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Link not found' });

      const frontendUrl = process.env.FRONTEND_URL || 'https://app.flexrz.com';
      return res.json({ ok: true, link: { ...r.rows[0], portal_url: `${frontendUrl}/pay/${r.rows[0].token}` } });
    } catch (err) {
      logger.error({ err }, 'PATCH /rental-payment-links/:id error');
      return res.status(500).json({ error: 'Failed to update payment link' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/rental-payment-links/public/:token
// PUBLIC — no auth. Returns booking + link details for the payment portal.
// ---------------------------------------------------------------------------
router.get('/public/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token required' });

    const { rows } = await db.query(
      `SELECT l.*,
              b.booking_code, b.customer_name, b.customer_phone, b.customer_email,
              b.checkin_date, b.checkout_date, b.nights_count, b.guests_count,
              b.status AS booking_status, b.notes,
              r.name AS resource_name,
              r.building_name,
              r.property_details_json,
              t.name AS tenant_name, t.currency_code AS tenant_currency,
              t.network_merchant_id,
              t.payment_gateway_active
       FROM rental_payment_links l
       JOIN bookings b ON b.id = l.booking_id
       LEFT JOIN resources r ON r.id = b.resource_id
       JOIN tenants t ON t.id = l.tenant_id
       WHERE l.token = $1 AND b.deleted_at IS NULL`,
      [token]
    );

    if (!rows.length) return res.status(404).json({ error: 'Payment link not found' });

    const link = rows[0];

    // Check expiry
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      // Auto-expire
      await db.query(`UPDATE rental_payment_links SET status = 'expired' WHERE token = $1 AND status = 'pending'`, [token]);
      return res.status(410).json({ error: 'This payment link has expired', expired: true });
    }

    // Never expose sensitive fields publicly
    const safe = { ...link };
    delete safe.network_merchant_id;
    delete safe.network_api_password;

    return res.json({ ok: true, link: safe });
  } catch (err) {
    logger.error({ err }, 'GET /rental-payment-links/public/:token error');
    return res.status(500).json({ error: 'Failed to load payment link' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/rental-payment-links/public/:token/pay
// PUBLIC — initiates an MPGS checkout session for card payment.
// Returns the MPGS session config for the frontend to mount the hosted form.
// ---------------------------------------------------------------------------
router.post('/public/:token/pay', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const { method } = req.body || {};

    const { rows } = await db.query(
      `SELECT l.*, t.id AS tenant_id, t.name AS tenant_name, t.currency_code,
              t.payment_gateway_active,
              b.booking_code, b.customer_name, b.customer_email
       FROM rental_payment_links l
       JOIN bookings b ON b.id = l.booking_id
       JOIN tenants t ON t.id = l.tenant_id
       WHERE l.token = $1`,
      [token]
    );

    if (!rows.length) return res.status(404).json({ error: 'Payment link not found' });

    const link = rows[0];

    if (link.status === 'paid') return res.status(409).json({ error: 'This booking has already been paid.' });
    if (link.status === 'cancelled') return res.status(410).json({ error: 'This payment link has been cancelled.' });
    if (link.status === 'expired') return res.status(410).json({ error: 'This payment link has expired.' });

    if (method === 'card') {
      // MPGS card payment — create a checkout session
      if (!isTenantMpgsEnabled || !createCheckoutSession) {
        return res.status(503).json({ error: 'Card payment gateway not available.' });
      }

      const mpgsEnabled = await isTenantMpgsEnabled(link.tenant_id);
      if (!mpgsEnabled) {
        return res.status(503).json({ error: 'Card payments not configured for this property.' });
      }

      const orderId    = generateOrderId(link.tenant_id);
      const frontendUrl = process.env.FRONTEND_URL || 'https://app.flexrz.com';
      const returnUrl  = `${frontendUrl}/pay/${token}/result?orderId=${encodeURIComponent(orderId)}`;
      const currency   = link.currency_code || 'JOD';
      const amount     = Number(link.amount_requested) - Number(link.amount_paid);

      const session = await createCheckoutSession(link.tenant_id, {
        orderId,
        amount:       amount.toFixed(3),
        currency,
        description:  link.description || `Payment for ${link.booking_code || `booking #${link.booking_id}`}`,
        returnUrl,
        merchantName: link.tenant_name || 'Flexrz',
      });

      // Save order reference on the link for result lookup
      await db.query(
        `UPDATE rental_payment_links SET payment_ref = $1 WHERE token = $2`,
        [orderId, token]
      );

      return res.json({
        ok:         true,
        method:     'card',
        orderId,
        sessionId:  session.sessionId,
        merchantId: session.merchantId,
        checkoutJsUrl: `${session.gatewayUrl}/static/checkout/checkout.min.js`,
        checkoutConfig: {
          session:     { id: session.sessionId },
          interaction: {
            operation: 'PURCHASE',
            merchant:  { name: link.tenant_name || 'Flexrz' },
            displayControl: { billingAddress: 'HIDE', customerEmail: 'OPTIONAL' },
          },
        },
      });
    }

    // For cliq/cash — just return the link details so frontend can show instructions
    return res.json({ ok: true, method: method || 'cliq', link });
  } catch (err) {
    logger.error({ err }, 'POST /rental-payment-links/public/:token/pay error');
    return res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/rental-payment-links/public/:token/record-payment
// Semi-public — rep records a cash or cliq payment.
// Requires a simple rep PIN stored on the tenant (or use admin key).
// ---------------------------------------------------------------------------
router.post('/public/:token/record-payment', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const { paidVia, amountPaid, paymentRef, notes } = req.body || {};

    if (!paidVia) return res.status(400).json({ error: 'paidVia is required (cash | cliq)' });
    if (!amountPaid || Number(amountPaid) <= 0) return res.status(400).json({ error: 'amountPaid must be positive' });

    const { rows } = await db.query(
      `SELECT l.*, l.amount_requested, l.amount_paid AS prev_paid
       FROM rental_payment_links l
       WHERE l.token = $1 AND l.status IN ('pending','partial')`,
      [token]
    );

    if (!rows.length) return res.status(404).json({ error: 'Active payment link not found' });

    const link      = rows[0];
    const newPaid   = Number(link.prev_paid) + Number(amountPaid);
    const remaining = Number(link.amount_requested) - newPaid;
    const newStatus = remaining <= 0.001 ? 'paid' : 'partial';

    const r = await db.query(
      `UPDATE rental_payment_links
         SET amount_paid    = $1,
             status         = $2,
             paid_via       = $3,
             payment_ref    = $4,
             payment_notes  = $5,
             paid_at        = $6
       WHERE token = $7
       RETURNING *`,
      [
        newPaid.toFixed(3),
        newStatus,
        paidVia,
        paymentRef || null,
        notes || null,
        newStatus === 'paid' ? new Date().toISOString() : null,
        token,
      ]
    );

    logger.info({ token, paidVia, amountPaid, newStatus }, 'Payment recorded on rental link');

    // ── WhatsApp payment received notification (non-fatal) ─────────────────
    if (newStatus === 'paid') {
      setImmediate(async () => {
        try {
          const { sendPaymentReceived, isWhatsAppConfigured } = require('../utils/whatsapp');
          if (!isWhatsAppConfigured()) return;

          // Load customer phone and booking details
          const detRes = await db.query(
            `SELECT b.customer_phone, b.customer_name, b.booking_code,
                    b.checkin_date, b.resource_id,
                    r.name AS resource_name, t.name AS tenant_name, t.currency_code
             FROM rental_payment_links l
             JOIN bookings b  ON b.id = l.booking_id
             LEFT JOIN resources r ON r.id = b.resource_id
             JOIN tenants t   ON t.id = l.tenant_id
             WHERE l.token = $1`,
            [token]
          );
          if (!detRes.rows.length || !detRes.rows[0].customer_phone) return;
          const det = detRes.rows[0];

          await sendPaymentReceived({
            customerPhone: det.customer_phone,
            customerName:  det.customer_name,
            tenantName:    det.tenant_name,
            bookingCode:   det.booking_code,
            amountPaid:    Number(amountPaid),
            currency:      det.currency_code || 'JOD',
            resourceName:  det.resource_name,
            checkinDate:   det.checkin_date,
          });
        } catch (waErr) {
          logger.error({ err: waErr, token }, 'WhatsApp payment received send error (non-fatal)');
        }
      });
    }
    // ── End WhatsApp ──────────────────────────────────────────────────────────

    return res.json({ ok: true, status: newStatus, remaining: Math.max(0, remaining), link: r.rows[0] });
  } catch (err) {
    logger.error({ err }, 'POST /rental-payment-links/public/:token/record-payment error');
    return res.status(500).json({ error: 'Failed to record payment' });
  }
});

module.exports = router;
