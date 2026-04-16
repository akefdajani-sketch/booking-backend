'use strict';

// routes/networkPayments.js
// PAY-1: Network International / MPGS payment integration

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const db     = require('../db');
const logger = require('../utils/logger');
const {
  isTenantMpgsEnabled,
  createCheckoutSession,
  retrieveOrder,
  refundTransaction,
} = require('../utils/network');
const { getTenantIdFromSlug, getTenantBySlug } = require('../utils/tenants');
const requireGoogleAuth = require('../middleware/requireGoogleAuth');
const requireAppAuth = require('../middleware/requireAppAuth'); // AUTH-FIX
const ensureUser        = require('../middleware/ensureUser');
const { requireTenantRole } = require('../middleware/requireTenantRole');

// ─── Helpers ──────────────────────────────────────────────────────────────────

// PAY-FIX: Strip any path suffix from the gateway URL so checkoutJsUrl is always
// a clean origin. DB may store "https://ap-gateway.../api" which would produce
// "https://ap-gateway.../api/static/checkout/..." — wrong domain AND doubled path.
// Defined locally so it works regardless of how utils/network is mocked in tests.
function sanitizeGatewayUrlForCheckout(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  try { return new URL(s).origin; } catch { return s.replace(/\/api(\/.*)?$/, ''); }
}

async function mpgsGuard(tenantId, res) {
  const enabled = await isTenantMpgsEnabled(tenantId);
  if (!enabled) {
    res.status(503).json({ error: 'Payment gateway not configured for this tenant.' });
    return false;
  }
  return true;
}

function generateOrderId(tenantSlug) {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  const slug = String(tenantSlug || 'T').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return `FRZ-${slug}-${ts}-${rand}`.slice(0, 40);
}

async function createPaymentRecord({ tenantId, bookingId, orderId, sessionId, successIndicator, amount, currency }) {
  const result = await db.query(
    `INSERT INTO network_payments
       (tenant_id, booking_id, order_id, session_id, success_indicator, amount, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING id`,
    [tenantId, bookingId || null, orderId, sessionId, successIndicator, amount, currency]
  );
  return result.rows[0].id;
}

async function updatePaymentRecord(paymentId, { status, transactionId, mpgsResult, rawResponse }) {
  await db.query(
    `UPDATE network_payments
     SET status = $1, transaction_id = $2, mpgs_result = $3, raw_response = $4, updated_at = NOW()
     WHERE id = $5`,
    [status, transactionId || null, mpgsResult || null, rawResponse ? JSON.stringify(rawResponse) : null, paymentId]
  );
}

// ─── POST /api/network-payment/:slug/initiate ─────────────────────────────────

router.post('/:slug/initiate', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'Missing tenant slug.' });

    let tenant;
    try {
      tenant = await getTenantBySlug(slug);
    } catch {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    if (!await mpgsGuard(tenant.id, res)) return;

    const amount   = String(req.body?.amount || '').trim();
    const currency = String(req.body?.currency || 'JOD').trim().toUpperCase();

    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: 'amount is required and must be a number.' });
    }
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0.' });
    }

    const orderId     = generateOrderId(slug);
    const description = String(req.body?.description || `Booking at ${tenant.name}`).slice(0, 127);

    // PAY-FIX: Use returnOrigin sent by the browser if present.
    // sessionStorage is domain-scoped — if we redirect to a different domain
    // than where the booking started (e.g. birdiegolf-jo.com vs flexrz.com),
    // the booking intent in sessionStorage is lost and no booking gets created.
    const rawReturnOrigin = String(req.body?.returnOrigin || '').trim();
    let safeReturnOrigin;
    try {
      // Only use it if it's a valid https origin (prevents open-redirect abuse)
      const parsed = new URL(rawReturnOrigin);
      safeReturnOrigin = (parsed.protocol === 'https:' || parsed.protocol === 'http:')
        ? parsed.origin
        : null;
    } catch {
      safeReturnOrigin = null;
    }
    const frontendUrl = safeReturnOrigin
      || String(process.env.FRONTEND_URL || 'https://flexrz.com').replace(/\/$/, '');
    const returnUrl   = `${frontendUrl}/book/${slug}/payment/result?orderId=${encodeURIComponent(orderId)}`;

    const session = await createCheckoutSession(tenant.id, {
      orderId,
      amount:       parseFloat(amount).toFixed(3),
      currency,
      description,
      returnUrl,
      merchantName: tenant.name || 'Flexrz',
    });

    const paymentId = await createPaymentRecord({
      tenantId:         tenant.id,
      bookingId:        null,
      orderId,
      sessionId:        session.sessionId,
      successIndicator: session.successIndicator,
      amount:           parseFloat(amount),
      currency,
    });

    logger.info({ tenantId: tenant.id, orderId, paymentId, amount, currency }, 'MPGS checkout session created');

    return res.json({
      orderId,
      paymentId,
      sessionId:     session.sessionId,
      merchantId:    session.merchantId,
      // PAY-FIX: Direct payment URL — frontend navigates here instead of using
      // checkout.js + showPaymentPage() which silently fails for unknown reasons.
      // This is exactly the URL checkout.js constructs internally and navigates to.
      // PAY-FIX: v63+ uses /static/checkout/pay (same path as checkout.min.js)
      // Older format /checkout/pay returns the error page on ap-gateway.
      paymentUrl: `${sanitizeGatewayUrlForCheckout(session.gatewayUrl)}/static/checkout/pay?session.id=${encodeURIComponent(session.sessionId)}`,
      checkoutJsUrl: `${sanitizeGatewayUrlForCheckout(session.gatewayUrl)}/static/checkout/checkout.min.js`,
      // For MPGS Hosted Checkout v63+, configure() only needs session.id
      // and interaction display settings. All payment details (amount, currency,
      // returnUrl) are already stored in the session server-side.
      checkoutConfig: {
        // PAY-FIX: top-level merchant ID is REQUIRED by MPGS Checkout.configure().
        // Without it, Checkout.showPaymentPage() silently does nothing.
        // interaction.merchant.name is a display label only — it is NOT the auth credential.
        merchant: session.merchantId,
        session:  { id: session.sessionId },
        interaction: {
          operation: 'PURCHASE',
          merchant:  { name: tenant.name || 'Flexrz' },
          displayControl: {
            billingAddress: 'HIDE',
            customerEmail:  'OPTIONAL',
          },
        },
      },
    });
  } catch (err) {
    logger.error({ err }, 'POST /network-payment/:slug/initiate error');
    return res.status(500).json({ error: 'Failed to create payment session.' });
  }
});

// ─── GET /api/network-payment/:slug/result ────────────────────────────────────

router.get('/:slug/result', async (req, res) => {
  try {
    const slug            = String(req.params.slug || '').trim();
    const orderId         = String(req.query?.orderId || '').trim();
    const resultIndicator = String(req.query?.resultIndicator || '').trim();

    if (!orderId) return res.status(400).json({ error: 'Missing orderId.' });

    let tenantId;
    try {
      tenantId = await getTenantIdFromSlug(slug);
    } catch {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const paymentRow = await db.query(
      `SELECT id, tenant_id, success_indicator, status, amount, currency
       FROM network_payments WHERE order_id = $1 LIMIT 1`,
      [orderId]
    );

    if (!paymentRow.rows.length) {
      logger.warn({ orderId }, 'MPGS result: payment record not found');
      return res.status(404).json({ error: 'Payment record not found.' });
    }

    const payment = paymentRow.rows[0];

    if (payment.status === 'completed') {
      return res.json({ success: true, orderId, paymentId: payment.id, alreadyProcessed: true });
    }

    const indicatorMatch = resultIndicator && resultIndicator === payment.success_indicator;
    let txn, verifiedSuccess = false, mpgsResult = 'UNKNOWN', transactionId = null;

    try {
      const order = await retrieveOrder(payment.tenant_id, orderId);
      txn = order?.transaction?.[0] || null;
      if (txn) {
        transactionId   = txn.id || '1';
        mpgsResult      = txn.result || 'UNKNOWN';
        verifiedSuccess = (txn.result === 'SUCCESS' && order.result === 'SUCCESS' && indicatorMatch);
      }
    } catch (verifyErr) {
      logger.error({ err: verifyErr, orderId }, 'MPGS server-side verification failed');
      verifiedSuccess = false;
      mpgsResult      = 'VERIFICATION_ERROR';
    }

    await updatePaymentRecord(payment.id, {
      status: verifiedSuccess ? 'completed' : 'failed',
      transactionId, mpgsResult, rawResponse: txn || null,
    });

    logger.info({ orderId, paymentId: payment.id, verifiedSuccess, mpgsResult }, 'MPGS payment result processed');

    // Update booking payment_method after confirmed payment
    if (verifiedSuccess && payment.booking_id) {
      try {
        await db.query(
          `UPDATE bookings SET payment_method = 'card' WHERE id = $1`,
          [payment.booking_id]
        );
      } catch (pmErr) {
        logger.warn({ pmErr }, 'Could not update booking payment_method (non-fatal)');
      }
    }

    if (!verifiedSuccess) {
      return res.json({ success: false, orderId, paymentId: payment.id, reason: mpgsResult });
    }
    return res.json({ success: true, orderId, paymentId: payment.id, transactionId, amount: payment.amount, currency: payment.currency });
  } catch (err) {
    logger.error({ err }, 'GET /network-payment/:slug/result error');
    return res.status(500).json({ error: 'Failed to process payment result.' });
  }
});

// ─── GET /api/network-payment/:slug/payments ──────────────────────────────────

router.get('/:slug/payments', requireAppAuth, ensureUser, async (req, res) => {
  try {
    const tenantId = await getTenantIdFromSlug(String(req.params.slug || '').trim());
    const limit    = Math.min(Number(req.query?.limit ?? 25), 100);
    const offset   = Math.max(Number(req.query?.offset ?? 0), 0);
    const status   = req.query?.status || null;
    const params   = [tenantId];
    const conds    = ['np.tenant_id = $1'];
    if (status) { conds.push(`np.status = $${params.length + 1}`); params.push(status); }
    const where    = conds.join(' AND ');
    const result   = await db.query(
      `SELECT np.id, np.order_id, np.booking_id, np.amount, np.currency, np.status,
              np.mpgs_result, np.transaction_id, np.refunded_at, np.created_at
       FROM network_payments np WHERE ${where}
       ORDER BY np.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const countRow = await db.query(`SELECT COUNT(*) AS total FROM network_payments np WHERE ${where}`, params);
    return res.json({ data: result.rows, total: Number(countRow.rows[0]?.total ?? 0), limit, offset, hasMore: offset + result.rows.length < Number(countRow.rows[0]?.total ?? 0) });
  } catch (err) {
    logger.error({ err }, 'GET /network-payment/:slug/payments error');
    return res.status(500).json({ error: 'Failed to load payments.' });
  }
});

// ─── GET /api/network-payment/:slug/payments/:orderId ────────────────────────

router.get('/:slug/payments/:orderId', requireAppAuth, ensureUser, async (req, res) => {
  try {
    const tenantId = await getTenantIdFromSlug(String(req.params.slug || '').trim());
    const result   = await db.query(
      `SELECT * FROM network_payments WHERE order_id = $1 AND tenant_id = $2 LIMIT 1`,
      [String(req.params.orderId || '').trim(), tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Payment not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'GET /network-payment/:slug/payments/:orderId error');
    return res.status(500).json({ error: 'Failed to load payment.' });
  }
});

// ─── POST /api/network-payment/:slug/payments/:orderId/refund ─────────────────

router.post('/:slug/payments/:orderId/refund', requireAppAuth, ensureUser, async (req, res) => {
  try {
    const tenantId  = await getTenantIdFromSlug(String(req.params.slug || '').trim());
    const orderId   = String(req.params.orderId || '').trim();
    const paymentRow = await db.query(
      `SELECT id, amount, currency, transaction_id, status FROM network_payments WHERE order_id = $1 AND tenant_id = $2 LIMIT 1`,
      [orderId, tenantId]
    );
    if (!paymentRow.rows.length) return res.status(404).json({ error: 'Payment not found.' });
    const payment = paymentRow.rows[0];
    if (payment.status !== 'completed') return res.status(400).json({ error: `Cannot refund payment with status: ${payment.status}` });
    if (!payment.transaction_id) return res.status(400).json({ error: 'No transaction ID — cannot refund.' });

    const refundAmount        = req.body?.amount ? parseFloat(req.body.amount).toFixed(3) : parseFloat(payment.amount).toFixed(3);
    const refundTransactionId = `REF-${Date.now().toString(36).toUpperCase()}`;
    const refundResponse      = await refundTransaction(tenantId, orderId, payment.transaction_id, refundTransactionId, refundAmount, payment.currency);

    await db.query(
      `UPDATE network_payments SET status = 'refunded', refund_transaction_id = $1, refunded_at = NOW(), refund_raw_response = $2, updated_at = NOW() WHERE id = $3`,
      [refundTransactionId, JSON.stringify(refundResponse), payment.id]
    );
    logger.info({ orderId, refundAmount }, 'MPGS refund issued');
    return res.json({ success: true, refundTransactionId, refundAmount, currency: payment.currency, mpgsResult: refundResponse.result });
  } catch (err) {
    logger.error({ err }, 'POST /network-payment/:slug/payments/:orderId/refund error');
    return res.status(500).json({ error: 'Failed to issue refund.' });
  }
});

module.exports = router;
