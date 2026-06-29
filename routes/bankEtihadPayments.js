'use strict';

// routes/bankEtihadPayments.js
// PAY-BAE: Bank al Etihad / Cybersource Unified Checkout payment routes.
//
// Mirrors the public surface of routes/networkPayments.js (MPGS) but adapted to
// the Cybersource UC flow:
//   POST /:slug/initiate  — mints the capture-context, inserts a pending row.
//   POST /:slug/complete  — accepts the up.complete() result from the browser,
//                           records the outcome on bank_etihad_payments.
//
// This file does NOT touch bookings. The booking flip (linking + payment_status)
// is owned by PIECE 2b (booking create/persist path).
//
// Architecture (DECIDED — see CLAUDE/Plan):
//   - No server-to-server /pts/v2 finalize. No webhooks. No JWKS.
//   - The browser relays the Cybersource up.complete() result; the backend
//     trusts it (signature NOT verified — BAE provides no public JWKS).
//   - status === 'AUTHORIZED' (live JWT path) OR 'COMPLETED' (spike-scaffold
//     object path) both count as success.

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const db     = require('../db');
const logger = require('../utils/logger');
const {
  isTenantBaeEnabled,
  createCaptureContext,
} = require('../utils/bankEtihad');
const { getTenantBySlug } = require('../utils/tenants');

// PR-6a: payment-link settlement utils. /complete uses these to settle a
// rental or contract-invoice payment link when the BAE row carries a link
// token instead of a booking_id. SettlementError → needs_reconcile reason.
const { settleRentalLinkByToken }          = require('../utils/rentalPaymentLinkSettlement');
const { settleContractInvoiceLinkByToken } = require('../utils/contractInvoiceLinkSettlement');
const { SettlementError }                  = require('../utils/settlementError');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function baeGuard(tenantId, res) {
  const enabled = await isTenantBaeEnabled(tenantId);
  if (!enabled) {
    res.status(503).json({ error: 'Payment gateway not configured for this tenant.' });
    return false;
  }
  return true;
}

// MRC format: <SLUG>-<YYYYMMDD>-<6 base36 random>, uppercase.
// Example: BIRDIE-20260617-A4F9K2. Slug prefix trimmed to alphanum and capped
// at 8 chars so the MRC fits comfortably within Cybersource's reference-code
// length limit.
function generateMrc(tenantSlug) {
  const slug = String(tenantSlug || 'T').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'T';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const n    = parseInt(crypto.randomBytes(4).toString('hex'), 16);
  const rand = n.toString(36).toUpperCase().padStart(6, '0').slice(-6);
  return `${slug}-${date}-${rand}`;
}

// Accept either a JWT string (live BAE path — signed completion JWT) or a
// plain object (spike-scaffold path — up.complete() resolving to a JS result).
// On JWT we base64url-decode the middle segment and DO NOT verify the signature
// (accepted risk — no JWKS published by BAE).
function normalizeCompletion(completion) {
  if (typeof completion === 'string') {
    const parts = completion.split('.');
    if (parts.length !== 3) {
      return { ok: false, reason: 'malformed_jwt' };
    }
    try {
      const b64    = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json   = Buffer.from(padded, 'base64').toString('utf8');
      return { ok: true, payload: JSON.parse(json), source: 'jwt' };
    } catch {
      return { ok: false, reason: 'jwt_decode_failed' };
    }
  }
  if (completion && typeof completion === 'object') {
    return { ok: true, payload: completion, source: 'object' };
  }
  return { ok: false, reason: 'malformed_completion' };
}

// Defensive transaction-id extraction. The exact path is not pinned by either
// the spike or BAE docs we have on hand — the first live completion will tell
// us. If none of these match, we store null and warn with the payload keys so
// the real shape is visible in logs without another redeploy.
function extractTransactionId(payload) {
  return (
    payload?.transactionId ||
    payload?.id ||
    payload?.reconciliationId ||
    payload?.processorInformation?.transactionId ||
    payload?.clientReferenceInformation?.code ||
    null
  );
}

async function createPaymentRecord({
  tenantId, orderId, captureContextId, amount, currency, rawResponse,
  // PR-6a: at most one of these is non-null (enforced by chk_bae_settle_target_exclusive).
  rentalPaymentLinkToken,
  contractInvoiceLinkToken,
}) {
  const result = await db.query(
    `INSERT INTO bank_etihad_payments
       (tenant_id, booking_id, order_id, capture_context_id, amount, currency, status, raw_response,
        rental_payment_link_token, contract_invoice_link_token)
     VALUES ($1, NULL, $2, $3, $4, $5, 'pending', $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      orderId,
      captureContextId || null,
      amount,
      currency,
      rawResponse ? JSON.stringify(rawResponse) : null,
      rentalPaymentLinkToken   || null,
      contractInvoiceLinkToken || null,
    ]
  );
  return result.rows[0].id;
}

async function updatePaymentRecord(paymentId, { status, transactionId, rawResponse }) {
  await db.query(
    `UPDATE bank_etihad_payments
       SET status         = $1,
           transaction_id = $2,
           raw_response   = $3,
           updated_at     = NOW()
     WHERE id = $4`,
    [
      status,
      transactionId || null,
      rawResponse ? JSON.stringify(rawResponse) : null,
      paymentId,
    ]
  );
}

// ─── POST /api/bank-etihad-payment/:slug/initiate ─────────────────────────────

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

    if (!await baeGuard(tenant.id, res)) return;

    const amount       = String(req.body?.amount || '').trim();
    const currency     = String(req.body?.currency || 'JOD').trim().toUpperCase();
    const targetOrigin = String(req.body?.targetOrigin || '').trim();

    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: 'amount is required and must be a number.' });
    }
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0.' });
    }
    if (!targetOrigin) {
      return res.status(400).json({ error: 'targetOrigin is required.' });
    }

    // PR-6a: optional settlement target. When the BAE flow is invoked from a
    // payment-link portal (/pay/[token] or /pay-invoice/[token]) the frontend
    // passes settleTarget so /complete knows what to settle. Booking flow
    // passes nothing; booking_id is back-edged later by routes/bookings/persist.
    //
    // This is the trust boundary. The token here is committed to the
    // bank_etihad_payments row; /complete reads it off the row and never
    // accepts a settlement target from the client. We refuse to mint a
    // capture context unless the token:
    //   (i)   exists in the corresponding link table,
    //   (ii)  belongs to THIS tenant (the :slug in the path),
    //   (iii) is in a settleable state — for rental: status IN ('pending','partial');
    //         for contract invoice: link.status='pending' AND invoice not paid/void/cancelled.
    let rentalPaymentLinkToken   = null;
    let contractInvoiceLinkToken = null;
    const settleTarget = req.body?.settleTarget;
    if (settleTarget != null) {
      const kind  = String(settleTarget.kind  || '').trim();
      const tokenIn = String(settleTarget.token || '').trim();

      if (!kind || !tokenIn) {
        return res.status(400).json({ error: 'settleTarget.kind and settleTarget.token are required.' });
      }
      if (kind !== 'rental_link' && kind !== 'contract_invoice_link') {
        return res.status(400).json({ error: 'settleTarget.kind must be rental_link or contract_invoice_link.' });
      }

      if (kind === 'rental_link') {
        const r = await db.query(
          `SELECT tenant_id, status
             FROM rental_payment_links
            WHERE token = $1
            LIMIT 1`,
          [tokenIn]
        );
        if (!r.rows.length) {
          return res.status(404).json({ error: 'Payment link not found.' });
        }
        if (Number(r.rows[0].tenant_id) !== Number(tenant.id)) {
          return res.status(403).json({ error: 'Payment link does not belong to this tenant.' });
        }
        if (!['pending', 'partial'].includes(r.rows[0].status)) {
          return res.status(409).json({ error: `Payment link is in '${r.rows[0].status}' state; cannot settle.` });
        }
        rentalPaymentLinkToken = tokenIn;
      } else {
        // contract_invoice_link — need both the link state and the invoice state.
        const r = await db.query(
          `SELECT cipl.tenant_id,
                  cipl.status      AS link_status,
                  ci.status        AS invoice_status
             FROM contract_invoice_payment_links cipl
             JOIN contract_invoices ci ON ci.id = cipl.contract_invoice_id
            WHERE cipl.token = $1
            LIMIT 1`,
          [tokenIn]
        );
        if (!r.rows.length) {
          return res.status(404).json({ error: 'Payment link not found.' });
        }
        if (Number(r.rows[0].tenant_id) !== Number(tenant.id)) {
          return res.status(403).json({ error: 'Payment link does not belong to this tenant.' });
        }
        if (r.rows[0].link_status !== 'pending') {
          return res.status(409).json({ error: `Payment link is in '${r.rows[0].link_status}' state; cannot settle.` });
        }
        if (['paid', 'void', 'cancelled'].includes(r.rows[0].invoice_status)) {
          return res.status(409).json({ error: `Invoice is ${r.rows[0].invoice_status}; cannot settle.` });
        }
        contractInvoiceLinkToken = tokenIn;
      }
    }

    const orderId = generateMrc(slug);

    let cc;
    try {
      cc = await createCaptureContext(tenant.id, {
        amount:   parseFloat(amount).toFixed(3),
        currency,
        targetOrigin,
        orderId,
      });
    } catch (err) {
      logger.error({ err, tenantId: tenant.id, orderId }, '[bae] capture-context request failed');
      return res.status(502).json({ error: 'Failed to create payment session.' });
    }

    const paymentId = await createPaymentRecord({
      tenantId:                 tenant.id,
      orderId,
      captureContextId:         cc.captureContext,
      amount:                   parseFloat(amount),
      currency,
      rawResponse:              cc.raw,
      rentalPaymentLinkToken,   // PR-6a (null for booking flow)
      contractInvoiceLinkToken, // PR-6a (null for booking flow)
    });

    logger.info({
      tenantId: tenant.id,
      orderId,
      paymentId,
      amount,
      currency,
      targetOrigin,
      hasCaptureContext: !!cc.captureContext,
      settleTargetKind:  rentalPaymentLinkToken ? 'rental_link'
                       : contractInvoiceLinkToken ? 'contract_invoice_link'
                       : null,
    }, '[bae] capture-context minted, pending payment row created');

    return res.json({
      orderId,
      paymentId,
      captureContext:         cc.captureContext,
      clientLibrary:          cc.clientLibrary,
      clientLibraryIntegrity: cc.clientLibraryIntegrity,
    });
  } catch (err) {
    logger.error({ err }, 'POST /bank-etihad-payment/:slug/initiate error');
    return res.status(500).json({ error: 'Failed to create payment session.' });
  }
});

// ─── POST /api/bank-etihad-payment/:slug/complete ─────────────────────────────
//
// Records the Cybersource completion outcome on bank_etihad_payments and, when
// the bank_etihad_payments row was linked to a booking at create time (PIECE 2b
// in routes/bookings/persist.js), flips that booking from the 17-min pending
// hold to confirmed + payment_status='completed'. Race-safe via WHERE guards
// that match only the still-pending hold state — the 2c expiry sweep cancelling
// the same booking cannot collide.

router.post('/:slug/complete', async (req, res) => {
  try {
    const slug    = String(req.params.slug || '').trim();
    const orderId = String(req.body?.orderId || '').trim();
    const completion = req.body?.completion;

    if (!slug)    return res.status(400).json({ error: 'Missing tenant slug.' });
    if (!orderId) return res.status(400).json({ error: 'orderId is required.' });
    if (completion == null) return res.status(400).json({ error: 'completion is required.' });

    let tenant;
    try {
      tenant = await getTenantBySlug(slug);
    } catch {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const lookup = await db.query(
      `SELECT id, status, booking_id,
              rental_payment_link_token,
              contract_invoice_link_token,
              amount
         FROM bank_etihad_payments
        WHERE tenant_id = $1 AND order_id = $2
        LIMIT 1`,
      [tenant.id, orderId]
    );
    if (!lookup.rows.length) {
      return res.status(404).json({ error: 'Payment record not found.' });
    }
    const payment = lookup.rows[0];

    const decoded = normalizeCompletion(completion);
    if (!decoded.ok) {
      logger.warn({ tenantId: tenant.id, orderId, reason: decoded.reason }, '[bae] malformed completion payload');
      return res.status(400).json({ error: 'Malformed completion payload.', reason: decoded.reason });
    }

    const payload = decoded.payload;
    const rawStatus = String(payload?.status || '').trim().toUpperCase();
    const isSuccess = rawStatus === 'AUTHORIZED' || rawStatus === 'COMPLETED';
    const transactionId = extractTransactionId(payload);

    if (isSuccess && !transactionId) {
      logger.warn(
        { tenantId: tenant.id, orderId, payloadKeys: Object.keys(payload || {}) },
        '[bae] success completion but no transaction_id matched any candidate path'
      );
    }

    await updatePaymentRecord(payment.id, {
      status:        isSuccess ? 'completed' : 'failed',
      transactionId,
      rawResponse:   payload,
    });

    logger.info({
      tenantId: tenant.id,
      orderId,
      paymentId: payment.id,
      source: decoded.source,
      status: rawStatus,
      isSuccess,
      hasTransactionId: !!transactionId,
    }, '[bae] completion recorded');

    // PAY-BAE (2b): on success, flip the linked booking out of its 17-min hold.
    // The WHERE guards (status='pending' AND payment_status='pending') make this
    // race-safe against the 2c expiry sweep — only one side can match a given
    // row's current state. On failure we leave the booking alone; the sweep
    // will cancel the expired hold. Non-fatal: a flip error must not turn a
    // successful payment into a 500 to the browser.
    //
    // PAY-BAE (3.6): two paths leave a payment AUTHORIZED with no confirmed
    // booking: flip rowCount===0 (booking already swept) and booking_id===NULL
    // (orphan — back-edge never set). Mark needs_reconcile so a human can pair
    // the money to a booking. status stays 'completed' — truthful that the
    // payment authorized at Cybersource.
    let needsReconcileReason = null;

    if (isSuccess && payment.booking_id) {
      try {
        const flip = await db.query(
          `UPDATE bookings
              SET status                  = 'confirmed',
                  payment_status          = 'completed',
                  payment_hold_expires_at = NULL,
                  updated_at              = NOW()
            WHERE id              = $1
              AND tenant_id       = $2
              AND status          = 'pending'
              AND payment_status  = 'pending'`,
          [payment.booking_id, tenant.id]
        );
        logger.info({
          tenantId: tenant.id,
          orderId,
          bookingId: payment.booking_id,
          rowCount: flip.rowCount,
        }, '[bae] booking hold flipped to confirmed');
        if (flip.rowCount === 0) {
          needsReconcileReason = 'swept';
        }
      } catch (flipErr) {
        logger.error({
          err: flipErr,
          tenantId: tenant.id,
          orderId,
          bookingId: payment.booking_id,
        }, '[bae] booking flip failed (non-fatal)');
      }
    } else if (isSuccess && payment.rental_payment_link_token) {
      // PR-6a: settle the rental_payment_link via the shared util. amountPaid:0
      // engages the util's card-settle-all branch — the util resolves the
      // link's CURRENT outstanding. expectedAmount carries the captured BAE
      // amount (M1 silent-over-collection guard): the util throws
      // amount_mismatch if outstanding has drifted (e.g. partial cash landed
      // between /initiate and /complete), so the link stays untouched and we
      // flag needs_reconcile instead of settling at the smaller outstanding
      // while the customer's card is over-collected.
      try {
        const settle = await settleRentalLinkByToken({
          token:          payment.rental_payment_link_token,
          paidVia:        'card',
          amountPaid:     0,
          paymentRef:     orderId,
          notes:          'BAE Unified Checkout',
          expectedAmount: Number(payment.amount), // PR-6a M1
        });
        logger.info({
          tenantId: tenant.id,
          orderId,
          paymentId: payment.id,
          linkToken: payment.rental_payment_link_token,
          status:    settle.status,
          fullyPaid: settle.fullyPaid,
        }, '[bae] rental payment link settled');
      } catch (settleErr) {
        needsReconcileReason = settleErr instanceof SettlementError
          ? `settle_failed_${settleErr.code}`
          : 'settle_failed';
        logger.error({
          err: settleErr,
          tenantId: tenant.id,
          orderId,
          paymentId: payment.id,
          linkToken: payment.rental_payment_link_token,
          reason:    needsReconcileReason,
        }, '[bae] rental link settle failed (will mark needs_reconcile)');
      }
    } else if (isSuccess && payment.contract_invoice_link_token) {
      // PR-6a: settle the contract_invoice_payment_link via the shared util.
      // The util owns its own transaction (BEGIN, SELECT FOR UPDATE, COMMIT)
      // — race-safe against a concurrent rep recording a cash payment.
      // expectedAmount enforces the M1 silent-over-collection guard, same as
      // the rental branch: ROLLBACK + amount_mismatch if outstanding drifted.
      try {
        const settle = await settleContractInvoiceLinkByToken({
          token:          payment.contract_invoice_link_token,
          paidVia:        'card',
          amountPaid:     0,
          paymentRef:     orderId,
          notes:          'BAE Unified Checkout',
          expectedAmount: Number(payment.amount), // PR-6a M1
        });
        logger.info({
          tenantId: tenant.id,
          orderId,
          paymentId: payment.id,
          linkToken: payment.contract_invoice_link_token,
          fullyPaid: settle.fullyPaid,
        }, '[bae] contract invoice link settled');
      } catch (settleErr) {
        needsReconcileReason = settleErr instanceof SettlementError
          ? `settle_failed_${settleErr.code}`
          : 'settle_failed';
        logger.error({
          err: settleErr,
          tenantId: tenant.id,
          orderId,
          paymentId: payment.id,
          linkToken: payment.contract_invoice_link_token,
          reason:    needsReconcileReason,
        }, '[bae] invoice link settle failed (will mark needs_reconcile)');
      }
    } else if (isSuccess) {
      // No settlement target attached at /initiate time — true orphan.
      // The exclusivity CHECK guarantees we land here only when booking_id,
      // rental_payment_link_token, and contract_invoice_link_token are all NULL.
      needsReconcileReason = 'orphan';
    }

    if (isSuccess && needsReconcileReason) {
      try {
        await db.query(
          `UPDATE bank_etihad_payments
              SET needs_reconcile = true,
                  updated_at      = NOW()
            WHERE id = $1`,
          [payment.id]
        );
      } catch (markErr) {
        logger.error({
          err: markErr,
          tenantId: tenant.id,
          orderId,
          paymentId: payment.id,
          reason: needsReconcileReason,
        }, '[bae] needs_reconcile mark failed (non-fatal)');
      }
      logger.error({
        tenantId: tenant.id,
        orderId,
        paymentId: payment.id,
        bookingId: payment.booking_id || null,
        reason: needsReconcileReason,
      }, '[bae] payment authorized but booking not confirmed — needs reconcile');
    }

    if (isSuccess) {
      if (needsReconcileReason) {
        return res.json({
          ok:             true,
          status:         rawStatus || 'AUTHORIZED',
          orderId,
          needsReconcile: true,
          reason:         needsReconcileReason,
        });
      }
      return res.json({ ok: true, status: rawStatus || 'AUTHORIZED', orderId });
    }
    return res.json({ ok: false, status: rawStatus || 'UNKNOWN', orderId });
  } catch (err) {
    logger.error({ err }, 'POST /bank-etihad-payment/:slug/complete error');
    return res.status(500).json({ error: 'Failed to process payment completion.' });
  }
});

module.exports = router;
