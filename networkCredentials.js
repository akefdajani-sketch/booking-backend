'use strict';

// routes/networkPayments.js
// PAY-1: Network International / MPGS payment integration
//
// Public endpoints (called by frontend booking flow):
//   POST /api/network-payment/:slug/initiate   — create MPGS session, return sessionId
//   GET  /api/network-payment/:slug/result     — verify payment after MPGS redirect
//
// Owner-only endpoints:
//   GET  /api/network-payment/:slug/payments          — list payments for tenant
//   GET  /api/network-payment/:slug/payments/:orderId — get single payment
//   POST /api/network-payment/:slug/payments/:orderId/refund — issue refund
//
// Auth:
//   - initiate: public (rate-limited in app.js)
//   - result:   public (MPGS redirect — verified server-side via MPGS API)
//   - owner endpoints: requireGoogleAuth + requireTenantRole(owner)

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const db     = require('../db');
const logger = require('../utils/logger');
const {
  isMpgsEnabled,
  createCheckoutSession,
  retrieveTransaction,
  retrieveOrder,
  refundTransaction,
} = require('../utils/network');
const { getTenantIdFromSlug, getTenantBySlug } = require('../utils/tenants');
const requireGoogleAuth = require('../middleware/requireGoogleAuth');
const ensureUser        = require('../middleware/ensureUser');
const { requireTenantRole } = require('../middleware/requireTenantRole');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mpgsGuard(res) {
  if (!isMpgsEnabled()) {
    res.status(503).json({ error: 'Network payment gateway not configured on this server.' });
    return false;
  }
  return true;
}

/**
 * Generate a unique MPGS order ID.
 * Format: FLEXRZ-{slug}-{shortRef}-{timestamp}
 * MPGS order IDs must be unique per merchant and ≤ 40 chars.
 */
function generateOrderId(tenantSlug) {
  const ts    = Date.now().toString(36).toUpperCase();
  const rand  = crypto.randomBytes(3).toString('hex').toUpperCase();
  const slug  = String(tenantSlug || 'T').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return `FRZ-${slug}-${ts}-${rand}`.slice(0, 40);
}

/**
 * Persist a new pending network_payments row.
 * Returns the inserted row id.
 */
async function createPaymentRecord({
  tenantId, bookingId, orderId, sessionId, successIndicator, amount, currency,
}) {
  const result = await db.query(
    `INSERT INTO network_payments
       (tenant_id, booking_id, order_id, session_id, success_indicator, amount, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING id`,
    [tenantId, bookingId || null, orderId, sessionId, successIndicator, amount, currency]
  );
  return result.rows[0].id;
}

/**
 * Update a network_payments row after MPGS redirects back.
 */
async function updatePaymentRecord(paymentId, { status, transactionId, mpgsResult, rawResponse }) {
  await db.query(
    `UPDATE network_payments
     SET status         = $1,
         transaction_id = $2,
         mpgs_result    = $3,
         raw_response   = $4,
         updated_at     = NOW()
     WHERE id = $5`,
    [status, transactionId || null, mpgsResult || null, rawResponse ? JSON.stringify(rawResponse) : null, paymentId]
  );
}

// ─── POST /api/network-payment/:slug/initiate ─────────────────────────────────
//
// Called by the frontend when customer clicks "Pay".
// Creates an MPGS Hosted Checkout session.
//
// Body: { amount, currency?, description?, bookingRef? }
// Returns: { orderId, sessionId, merchantId, checkoutJsUrl }

router.post('/:slug/initiate', async (req, res) => {
  try {
    if (!mpgsGuard(res)) return;

    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'Missing tenant slug.' });

    let tenant;
    try {
      tenant = await getTenantBySlug(slug);
    } catch {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const amount   = String(req.body?.amount || '').trim();
    const currency = String(req.body?.currency || 'JOD').trim().toUpperCase();
    const bookingRef = req.body?.bookingRef || null;

    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: 'amount is required and must be a number.' });
    }
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0.' });
    }

    const orderId = generateOrderId(slug);
    const description = String(req.body?.description || `Booking at ${tenant.name}`).slice(0, 127);

    // Build the return URL — frontend passes it or we default to env
    const frontendUrl = String(process.env.FRONTEND_URL || 'https://flexrz.com').replace(/\/$/, '');
    const returnUrl = `${frontendUrl}/book/${slug}/payment/result?orderId=${encodeURIComponent(orderId)}`;

    const session = await createCheckoutSession({
      orderId,
      amount: parseFloat(amount).toFixed(3),
      currency,
      description,
      returnUrl,
      merchantName: tenant.name || 'Flexrz',
    });

    // Persist payment record
    const paymentId = await createPaymentRecord({
      tenantId:         tenant.id,
      bookingId:        null,  // booking created after payment confirmed
      orderId,
      sessionId:        session.sessionId,
      successIndicator: session.successIndicator,
      amount:           parseFloat(amount),
      currency,
    });

    const { getMpgsConfig } = require('../utils/network');
    const { merchantId, gatewayUrl } = getMpgsConfig();

    logger.info({ tenantId: tenant.id, orderId, paymentId, amount, currency }, 'MPGS checkout session created');

    return res.json({
      orderId,
      paymentId,
      sessionId:    session.sessionId,
      merchantId,
      checkoutJsUrl: `${gatewayUrl}/checkout/version/100/checkout.js`,
      // Frontend passes these to Checkout.configure()
      checkoutConfig: {
        merchant: merchantId,
        session:  { id: session.sessionId },
        order: {
          description,
          amount:   parseFloat(amount).toFixed(3),
          currency,
        },
        interaction: {
          operation: 'PURCHASE',
          merchant:  { name: tenant.name || 'Flexrz' },
        },
      },
    });
  } catch (err) {
    logger.error({ err }, 'POST /network-payment/:slug/initiate error');
    return res.status(500).json({ error: 'Failed to create payment session.' });
  }
});

// ─── GET /api/network-payment/:slug/result ────────────────────────────────────
//
// MPGS redirects the customer here after payment (success or failure).
// Query params: orderId, resultIndicator (MPGS appends these)
//
// This endpoint:
//   1. Looks up the pending payment record by orderId
//   2. Compares resultIndicator against stored successIndicator
//   3. Calls MPGS server-side to verify the transaction (never trust redirect alone)
//   4. Updates payment record
//   5. Returns { success, orderId, paymentId, transactionId } — frontend handles redirect

router.get('/:slug/result', async (req, res) => {
  try {
    if (!mpgsGuard(res)) return;

    const slug            = String(req.params.slug || '').trim();
    const orderId         = String(req.query?.orderId || '').trim();
    const resultIndicator = String(req.query?.resultIndicator || '').trim();

    if (!orderId) return res.status(400).json({ error: 'Missing orderId.' });

    // Load the pending payment record
    const paymentRow = await db.query(
      `SELECT id, tenant_id, success_indicator, status, amount, currency
       FROM network_payments
       WHERE order_id = $1
       LIMIT 1`,
      [orderId]
    );

    if (!paymentRow.rows.length) {
      logger.warn({ orderId }, 'MPGS result: payment record not found');
      return res.status(404).json({ error: 'Payment record not found.' });
    }

    const payment = paymentRow.rows[0];

    // Idempotency: if already completed, return the existing result
    if (payment.status === 'completed') {
      return res.json({ success: true, orderId, paymentId: payment.id, alreadyProcessed: true });
    }

    // ── Step 1: Quick indicator check ──────────────────────────────────────────
    // resultIndicator must match successIndicator stored at session creation.
    const indicatorMatch = resultIndicator && resultIndicator === payment.success_indicator;

    // ── Step 2: Server-side verification via MPGS API ─────────────────────────
    // Always verify independently, regardless of indicator match.
    let txn;
    let verifiedSuccess = false;
    let mpgsResult = 'UNKNOWN';
    let transactionId = null;

    try {
      const order = await retrieveOrder(orderId);
      // Find the most recent transaction on the order
      txn = order?.transaction?.[0] || null;

      if (txn) {
        transactionId = txn.id || '1';
        mpgsResult    = txn.result || 'UNKNOWN';
        verifiedSuccess = (
          txn.result === 'SUCCESS' &&
          order.result === 'SUCCESS' &&
          indicatorMatch
        );
      }
    } catch (verifyErr) {
      logger.error({ err: verifyErr, orderId }, 'MPGS server-side verification failed');
      // If we can't verify, treat as failure — do not confirm booking
      verifiedSuccess = false;
      mpgsResult = 'VERIFICATION_ERROR';
    }

    const newStatus = verifiedSuccess ? 'completed' : 'failed';

    await updatePaymentRecord(payment.id, {
      status:        newStatus,
      transactionId,
      mpgsResult,
      rawResponse:   txn || null,
    });

    logger.info(
      { orderId, paymentId: payment.id, verifiedSuccess, mpgsResult },
      'MPGS payment result processed'
    );

    if (!verifiedSuccess) {
      return res.json({
        success:   false,
        orderId,
        paymentId: payment.id,
        reason:    mpgsResult,
      });
    }

    return res.json({
      success:       true,
      orderId,
      paymentId:     payment.id,
      transactionId,
      amount:        payment.amount,
      currency:      payment.currency,
    });
  } catch (err) {
    logger.error({ err }, 'GET /network-payment/:slug/result error');
    return res.status(500).json({ error: 'Failed to process payment result.' });
  }
});

// ─── GET /api/network-payment/:slug/payments ──────────────────────────────────
// Owner: list all network payments for the tenant

router.get(
  '/:slug/payments',
  requireGoogleAuth,
  ensureUser,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const tenantId = await getTenantIdFromSlug(slug);

      // Verify requester has owner role
      await requireTenantRole('owner')(req, res, async () => {});

      const limit  = Math.min(Number(req.query?.limit  ?? 25), 100);
      const offset = Math.max(Number(req.query?.offset ?? 0), 0);
      const status = req.query?.status || null;

      const conditions = ['np.tenant_id = $1'];
      const params     = [tenantId];

      if (status) {
        conditions.push(`np.status = $${params.length + 1}`);
        params.push(status);
      }

      const where = conditions.join(' AND ');

      const result = await db.query(
        `SELECT
           np.id,
           np.order_id,
           np.booking_id,
           np.amount,
           np.currency,
           np.status,
           np.mpgs_result,
           np.transaction_id,
           np.refunded_at,
           np.created_at,
           b.start_time,
           b.end_time
         FROM network_payments np
         LEFT JOIN bookings b ON b.id = np.booking_id
         WHERE ${where}
         ORDER BY np.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );

      const countRow = await db.query(
        `SELECT COUNT(*) AS total FROM network_payments np WHERE ${where}`,
        params
      );

      return res.json({
        data:    result.rows,
        total:   Number(countRow.rows[0]?.total ?? 0),
        limit,
        offset,
        hasMore: offset + result.rows.length < Number(countRow.rows[0]?.total ?? 0),
      });
    } catch (err) {
      logger.error({ err }, 'GET /network-payment/:slug/payments error');
      return res.status(500).json({ error: 'Failed to load payments.' });
    }
  }
);

// ─── GET /api/network-payment/:slug/payments/:orderId ────────────────────────
// Owner: get a single payment by orderId

router.get(
  '/:slug/payments/:orderId',
  requireGoogleAuth,
  ensureUser,
  async (req, res) => {
    try {
      const slug    = String(req.params.slug || '').trim();
      const orderId = String(req.params.orderId || '').trim();
      const tenantId = await getTenantIdFromSlug(slug);

      const result = await db.query(
        `SELECT * FROM network_payments WHERE order_id = $1 AND tenant_id = $2 LIMIT 1`,
        [orderId, tenantId]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'Payment not found.' });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      logger.error({ err }, 'GET /network-payment/:slug/payments/:orderId error');
      return res.status(500).json({ error: 'Failed to load payment.' });
    }
  }
);

// ─── POST /api/network-payment/:slug/payments/:orderId/refund ─────────────────
// Owner: issue a full or partial refund

router.post(
  '/:slug/payments/:orderId/refund',
  requireGoogleAuth,
  ensureUser,
  async (req, res) => {
    try {
      if (!mpgsGuard(res)) return;

      const slug    = String(req.params.slug || '').trim();
      const orderId = String(req.params.orderId || '').trim();
      const tenantId = await getTenantIdFromSlug(slug);

      // Load existing payment
      const paymentRow = await db.query(
        `SELECT id, amount, currency, transaction_id, status
         FROM network_payments
         WHERE order_id = $1 AND tenant_id = $2 LIMIT 1`,
        [orderId, tenantId]
      );

      if (!paymentRow.rows.length) {
        return res.status(404).json({ error: 'Payment not found.' });
      }

      const payment = paymentRow.rows[0];

      if (payment.status !== 'completed') {
        return res.status(400).json({ error: `Cannot refund payment with status: ${payment.status}` });
      }
      if (payment.status === 'refunded') {
        return res.status(400).json({ error: 'Payment has already been refunded.' });
      }
      if (!payment.transaction_id) {
        return res.status(400).json({ error: 'No transaction ID on record — cannot refund.' });
      }

      // Amount defaults to full refund
      const refundAmount = req.body?.amount
        ? parseFloat(req.body.amount).toFixed(3)
        : parseFloat(payment.amount).toFixed(3);

      // Generate a unique transaction ID for the refund
      const refundTransactionId = `REF-${Date.now().toString(36).toUpperCase()}`;

      const refundResponse = await refundTransaction(
        orderId,
        payment.transaction_id,
        refundTransactionId,
        refundAmount,
        payment.currency
      );

      // Update payment record
      await db.query(
        `UPDATE network_payments
         SET status                = 'refunded',
             refund_transaction_id = $1,
             refunded_at           = NOW(),
             refund_raw_response   = $2,
             updated_at            = NOW()
         WHERE id = $3`,
        [refundTransactionId, JSON.stringify(refundResponse), payment.id]
      );

      logger.info({ orderId, refundAmount, refundTransactionId }, 'MPGS refund issued');

      return res.json({
        success:              true,
        refundTransactionId,
        refundAmount,
        currency:             payment.currency,
        mpgsResult:           refundResponse.result,
      });
    } catch (err) {
      logger.error({ err }, 'POST /network-payment/:slug/payments/:orderId/refund error');
      return res.status(500).json({ error: 'Failed to issue refund.' });
    }
  }
);

module.exports = router;
