'use strict';

// PR-6a: settlement util for contract_invoice_payment_links.
//
// Extracted byte-identically from POST /public/:token/record-payment in
// routes/contractInvoicePaymentLinks.js. Transaction semantics preserved
// EXACTLY: pool.connect → BEGIN → SELECT FOR UPDATE on both rows →
// conditional UPDATEs → COMMIT or ROLLBACK → release in finally. Same status
// checks, same payment_ref/payment_notes COALESCE, same partial vs fully-paid
// link behavior, same 0.001 threshold.
//
// Errors are normalized to SettlementError so callers (the route handler AND
// BAE /complete) map them uniformly.

const db = require('../db');
const { SettlementError } = require('./settlementError');

/**
 * Settle (or partially settle) a contract invoice payment link by token.
 *
 * @param {Object} args
 * @param {string} args.token
 * @param {string} args.paidVia      'cliq' | 'cash' | 'card'
 * @param {number} args.amountPaid   Positive number, OR 0/null/undefined when
 *                                   paidVia==='card' (settle outstanding).
 * @param {string} [args.paymentRef]
 * @param {string} [args.notes]
 * @param {number} [args.expectedAmount]
 *   PR-6a M1: the amount captured at the payment provider (BAE
 *   bank_etihad_payments.amount). When provided AND we're on the
 *   card-settle-all path, the util verifies the resolved outstanding equals
 *   this value within fils tolerance (0.001) BEFORE any UPDATE. Mismatch →
 *   ROLLBACK and SettlementError 'amount_mismatch' (invoice + link untouched).
 *   Only passed by BAE /complete; the route record-payment handler does NOT
 *   pass it, so route behavior remains byte-identical to pre-extraction.
 *
 * @returns {Promise<{
 *   fullyPaid: boolean,
 *   remaining: number,
 *   amountPaidApplied: number,
 *   linkId: number,
 *   contractInvoiceId: number,
 *   invoice: { id, amount, amountPaid, status, currencyCode },
 * }>}
 *
 * @throws {SettlementError} codes:
 *   - 'invalid_paidVia', 'invalid_amount'
 *   - 'link_not_found', 'link_not_pending'
 *   - 'already_paid', 'invoice_void', 'invoice_cancelled'
 *   - 'nothing_to_settle' (card-settle-all with outstanding<=0)
 *   - 'amount_mismatch'   (expectedAmount provided but != outstanding — M1)
 */
async function settleContractInvoiceLinkByToken({ token, paidVia, amountPaid, paymentRef, notes, expectedAmount }) {
  const ALLOWED_METHODS = ['cliq', 'cash', 'card'];
  if (!ALLOWED_METHODS.includes(paidVia)) {
    throw new SettlementError({
      code:       'invalid_paidVia',
      message:    "paidVia must be 'cliq', 'cash', or 'card'",
      httpStatus: 400,
    });
  }

  let amount = Number(amountPaid);
  const isCardSettleAll = paidVia === 'card' && (!amountPaid || amount === 0);
  if (!isCardSettleAll) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new SettlementError({
        code:       'invalid_amount',
        message:    'amountPaid must be a positive number',
        httpStatus: 400,
      });
    }
  }

  const t = String(token || '').trim();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the link row + invoice row. Identical SELECT shape and FOR UPDATE
    // targets as the original route — race-safe against concurrent settlement.
    const linkRes = await client.query(
      `SELECT cipl.id            AS link_id,
              cipl.token,
              cipl.status        AS link_status,
              cipl.contract_invoice_id,
              cipl.tenant_id,
              ci.amount          AS invoice_amount,
              ci.amount_paid     AS invoice_amount_paid,
              ci.status          AS invoice_status,
              ci.currency_code
         FROM contract_invoice_payment_links cipl
         JOIN contract_invoices ci ON ci.id = cipl.contract_invoice_id
        WHERE cipl.token = $1
          FOR UPDATE OF cipl, ci`,
      [t]
    );
    if (!linkRes.rows.length) {
      await client.query('ROLLBACK');
      throw new SettlementError({
        code:       'link_not_found',
        message:    'Payment link not found',
        httpStatus: 404,
      });
    }
    const r = linkRes.rows[0];

    if (r.link_status !== 'pending') {
      await client.query('ROLLBACK');
      throw new SettlementError({
        code:       'link_not_pending',
        message:    `Link is in '${r.link_status}' state, cannot record payment`,
        httpStatus: 409,
      });
    }
    if (r.invoice_status === 'paid') {
      await client.query('ROLLBACK');
      throw new SettlementError({
        code:       'already_paid',
        message:    'Invoice already fully paid',
        httpStatus: 409,
      });
    }
    if (['void', 'cancelled'].includes(r.invoice_status)) {
      await client.query('ROLLBACK');
      throw new SettlementError({
        code:       r.invoice_status === 'void' ? 'invoice_void' : 'invoice_cancelled',
        message:    `Invoice is ${r.invoice_status}`,
        httpStatus: 409,
      });
    }

    if (isCardSettleAll) {
      amount = Number(r.invoice_amount) - Number(r.invoice_amount_paid);
      if (amount <= 0) {
        await client.query('ROLLBACK');
        throw new SettlementError({
          code:       'nothing_to_settle',
          message:    'Nothing left to pay on this invoice',
          httpStatus: 409,
        });
      }
      // PR-6a M1: silent-over-collection guard. See the matching block in
      // utils/rentalPaymentLinkSettlement.js for full rationale. Same fils
      // tolerance (0.001), same semantics — caller-provided captured amount
      // must equal the live outstanding within one fils, else we ROLLBACK
      // without touching the invoice or the link, and the BAE /complete
      // branch flags needs_reconcile_settle_failed_amount_mismatch.
      if (expectedAmount != null) {
        const expected = Number(expectedAmount);
        if (Number.isFinite(expected) && Math.abs(amount - expected) > 0.001) {
          await client.query('ROLLBACK');
          throw new SettlementError({
            code:       'amount_mismatch',
            message:    `Captured amount ${expected.toFixed(3)} does not match outstanding ${amount.toFixed(3)}`,
            httpStatus: 409,
          });
        }
      }
    }

    const newPaid          = Number(r.invoice_amount_paid) + amount;
    const remaining        = Number(r.invoice_amount) - newPaid;
    const fullyPaid        = remaining <= 0.001;
    const newInvoiceStatus = fullyPaid ? 'paid' : 'partial';

    // 1. Update the invoice (source of truth for payment metadata).
    await client.query(
      `UPDATE contract_invoices
          SET amount_paid    = $1,
              status         = $2,
              payment_method = $3,
              payment_ref    = COALESCE($4, payment_ref),
              payment_notes  = COALESCE($5, payment_notes),
              paid_at        = CASE WHEN $2 = 'paid' THEN NOW() ELSE paid_at END
        WHERE id = $6`,
      [
        newPaid.toFixed(3),
        newInvoiceStatus,
        paidVia,
        paymentRef || null,
        notes || null,
        r.contract_invoice_id,
      ]
    );

    // 2. Flip the LINK only when fully paid. Partial leaves link 'pending' so
    //    the customer can return and finish.
    if (fullyPaid) {
      await client.query(
        `UPDATE contract_invoice_payment_links
            SET status = 'paid', paid_at = NOW()
          WHERE id = $1`,
        [r.link_id]
      );
    }

    await client.query('COMMIT');

    return {
      fullyPaid,
      remaining:         Math.max(0, remaining),
      amountPaidApplied: amount,
      linkId:            r.link_id,
      contractInvoiceId: r.contract_invoice_id,
      invoice: {
        id:           r.contract_invoice_id,
        amount:       r.invoice_amount,
        amountPaid:   newPaid.toFixed(3),
        status:       newInvoiceStatus,
        currencyCode: r.currency_code,
      },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { settleContractInvoiceLinkByToken };
