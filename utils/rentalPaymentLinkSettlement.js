'use strict';

// PR-6a: settlement util for rental_payment_links.
//
// Extracted from POST /public/:token/record-payment in
// routes/rentalPaymentLinks.js. Byte-identical behavior for the cash/cliq
// path it was extracted from — same SELECT shape, same non-transactional
// SELECT-then-UPDATE, same fields written, same status threshold (0.001).
//
// Adds one path NOT in the original route: paidVia='card' + amountPaid===0
// (or omitted) is interpreted as "settle the full current outstanding" —
// the card-settle-all convention used by BAE /complete. The rental route's
// POST handler still rejects amountPaid<=0 at its own layer (see the
// known-issue note in that file); only /complete reaches this new branch.

const db = require('../db');
const { SettlementError } = require('./settlementError');

/**
 * Settle (or partially settle) a rental payment link by token.
 *
 * @param {Object} args
 * @param {string} args.token
 * @param {string} args.paidVia      'cash' | 'cliq' | 'card'
 * @param {number} args.amountPaid   Positive number, OR 0/null/undefined when
 *                                   paidVia==='card' to settle outstanding.
 * @param {string} [args.paymentRef]
 * @param {string} [args.notes]
 * @param {number} [args.expectedAmount]
 *   PR-6a M1: the amount captured at the payment provider (BAE
 *   bank_etihad_payments.amount). When provided AND we're on the
 *   card-settle-all path, the util verifies the resolved outstanding equals
 *   this value within fils tolerance (0.001 — matches the existing fully-paid
 *   threshold) BEFORE any UPDATE. Mismatch → SettlementError 'amount_mismatch'
 *   (link untouched, caller marks needs_reconcile). Only passed by BAE
 *   /complete; the route record-payment handler does NOT pass it, so route
 *   behavior remains byte-identical to pre-extraction.
 *
 * @returns {Promise<{
 *   status: 'paid' | 'partial',
 *   fullyPaid: boolean,
 *   amountPaidApplied: number,
 *   remaining: number,
 *   link: Object,
 * }>}
 *
 * @throws {SettlementError} codes:
 *   - 'link_not_found'    — token has no row in 'pending' | 'partial' status.
 *   - 'invalid_amount'    — non-card path with non-positive amount.
 *   - 'nothing_to_settle' — card-settle-all but outstanding <= 0.
 *   - 'amount_mismatch'   — expectedAmount provided but != outstanding (M1).
 */
async function settleRentalLinkByToken({ token, paidVia, amountPaid, paymentRef, notes, expectedAmount }) {
  const t = String(token || '').trim();

  // Same SELECT shape and status filter as the original route handler.
  // Non-transactional — matches the route's existing behavior byte-for-byte.
  const { rows } = await db.query(
    `SELECT l.*, l.amount_requested, l.amount_paid AS prev_paid
     FROM rental_payment_links l
     WHERE l.token = $1 AND l.status IN ('pending','partial')`,
    [t]
  );
  if (!rows.length) {
    throw new SettlementError({
      code:       'link_not_found',
      message:    'Active payment link not found',
      httpStatus: 404,
    });
  }
  const link = rows[0];

  // card-settle-all: paidVia='card' AND amountPaid omitted/zero → resolve to
  // outstanding. NEW path (not in the original route); used by BAE /complete.
  let amount = Number(amountPaid);
  const isCardSettleAll = paidVia === 'card' && (!amountPaid || amount === 0);
  if (isCardSettleAll) {
    amount = Number(link.amount_requested) - Number(link.prev_paid);
    if (amount <= 0) {
      throw new SettlementError({
        code:       'nothing_to_settle',
        message:    'Nothing left to pay on this link',
        httpStatus: 409,
      });
    }
    // PR-6a M1: silent-over-collection guard. If the caller supplied the
    // captured-at-provider amount, refuse to settle when it doesn't match
    // the live outstanding within fils tolerance (0.001, same threshold
    // used for fully-paid). The dangerous case: cash/cliq partial payment
    // landed between /initiate and /complete, so outstanding < captured;
    // without this check we'd settle outstanding and silently mark paid,
    // leaving the customer's card over-collected with no audit signal.
    // Throw BEFORE any UPDATE so the link row is untouched and the BAE
    // /complete branch flags needs_reconcile_settle_failed_amount_mismatch.
    if (expectedAmount != null) {
      const expected = Number(expectedAmount);
      if (Number.isFinite(expected) && Math.abs(amount - expected) > 0.001) {
        throw new SettlementError({
          code:       'amount_mismatch',
          message:    `Captured amount ${expected.toFixed(3)} does not match outstanding ${amount.toFixed(3)}`,
          httpStatus: 409,
        });
      }
    }
  } else if (!Number.isFinite(amount) || amount <= 0) {
    throw new SettlementError({
      code:       'invalid_amount',
      message:    'amountPaid must be a positive number',
      httpStatus: 400,
    });
  }

  const newPaid   = Number(link.prev_paid) + amount;
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
      t,
    ]
  );

  return {
    status:            newStatus,
    fullyPaid:         newStatus === 'paid',
    amountPaidApplied: amount,
    remaining:         Math.max(0, remaining),
    link:              r.rows[0],
  };
}

module.exports = { settleRentalLinkByToken };
