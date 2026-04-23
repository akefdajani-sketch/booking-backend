'use strict';

// routes/contracts/invoices.js
// G2a-2: Contract invoice actions.
//
// POST /api/contracts/:id/invoices/:milestoneIndex/send-invoice
//   — Creates a Stripe invoice for the milestone, finalizes + sends.
//     Writes stripe_invoice_id, status='sent' on contract_invoices row.
//
// POST /api/contracts/:id/invoices/:milestoneIndex/mark-paid
//   — Manual receipt marking (cash / bank transfer / cliq / card).
//     Sets status='paid', amount_paid=amount, paid_at=NOW().
//     If stripe_invoice_id present, also tells Stripe paid_out_of_band.
//
// Both endpoints require authenticated tenant user, tenant-scope every query.

const { pool } = require('../../db');
const logger = require('../../utils/logger');
const {
  createStripeInvoiceForMilestone,
  markStripeInvoicePaidOutOfBand,
} = require('../../utils/stripeInvoicing');

const VALID_PAYMENT_METHODS = new Set(['card', 'cliq', 'cash', 'stripe', 'other']);

// ---------------------------------------------------------------------------
// Shared loader
// ---------------------------------------------------------------------------

async function loadContractInvoiceBundle(tenantId, contractId, milestoneIndex) {
  const { rows: contractRows } = await pool.query(
    `SELECT * FROM contracts WHERE id = $1 AND tenant_id = $2`,
    [contractId, tenantId]
  );
  if (contractRows.length === 0) return { notFound: 'contract' };
  const contract = contractRows[0];

  const { rows: invRows } = await pool.query(
    `SELECT * FROM contract_invoices
      WHERE tenant_id = $1 AND contract_id = $2 AND milestone_index = $3`,
    [tenantId, contractId, milestoneIndex]
  );
  if (invRows.length === 0) return { notFound: 'invoice' };
  const invoice = invRows[0];

  const { rows: customerRows } = await pool.query(
    `SELECT * FROM customers WHERE id = $1 AND tenant_id = $2`,
    [contract.customer_id, tenantId]
  );
  if (customerRows.length === 0) return { notFound: 'customer' };

  const { rows: tenantRows } = await pool.query(
    `SELECT * FROM tenants WHERE id = $1`, [tenantId]
  );

  return {
    contract,
    invoice,
    customer: customerRows[0],
    tenant: tenantRows[0],
  };
}

// ---------------------------------------------------------------------------
// Mount handlers
// ---------------------------------------------------------------------------

module.exports = function mount(router) {
  // ─── POST /:id/invoices/:milestoneIndex/send-invoice ─────────────────────
  router.post('/:id/invoices/:milestoneIndex/send-invoice', async (req, res, next) => {
    const tenantId       = Number(req.user && req.user.tenant_id);
    const contractId     = Number(req.params.id);
    const milestoneIndex = Number(req.params.milestoneIndex);

    if (!tenantId) return res.status(401).json({ error: 'unauthorized' });
    if (!Number.isInteger(contractId) || !Number.isInteger(milestoneIndex) || milestoneIndex < 0) {
      return res.status(400).json({ error: 'invalid path params' });
    }

    try {
      const bundle = await loadContractInvoiceBundle(tenantId, contractId, milestoneIndex);
      if (bundle.notFound) {
        return res.status(404).json({ error: `${bundle.notFound} not found` });
      }

      const { contract, invoice, customer, tenant } = bundle;

      // Guard: contract must be signed/active, not cancelled
      if (!['signed', 'active'].includes(contract.status)) {
        return res.status(409).json({
          error: 'contract_not_active',
          message: `Cannot send invoice when contract status is '${contract.status}'.`,
        });
      }

      // Guard: invoice must be pending (no duplicate sends)
      if (invoice.status !== 'pending') {
        return res.status(409).json({
          error: 'invoice_not_pending',
          message: `Invoice is already '${invoice.status}'.`,
          stripe_invoice_id: invoice.stripe_invoice_id || null,
        });
      }

      // Create Stripe invoice
      const result = await createStripeInvoiceForMilestone({
        contract, contractInvoice: invoice, tenant, customer,
      });

      // Persist Stripe ID + flip status
      await pool.query(
        `UPDATE contract_invoices
            SET stripe_invoice_id = $1,
                payment_method    = COALESCE(payment_method, 'stripe'),
                status            = 'sent',
                sent_at           = NOW(),
                updated_at        = NOW()
          WHERE id = $2 AND tenant_id = $3`,
        [result.stripeInvoiceId, invoice.id, tenantId]
      );

      logger.info({
        tenantId, contractId, milestoneIndex,
        stripeInvoiceId: result.stripeInvoiceId,
      }, 'contract invoice sent via Stripe');

      return res.json({
        ok: true,
        stripe_invoice_id:   result.stripeInvoiceId,
        hosted_invoice_url:  result.hostedInvoiceUrl,
        status:              'sent',
      });
    } catch (err) {
      logger.error({ tenantId, contractId, milestoneIndex, err: err && err.message },
                   'send-invoice failed');
      return next(err);
    }
  });

  // ─── POST /:id/invoices/:milestoneIndex/mark-paid ────────────────────────
  router.post('/:id/invoices/:milestoneIndex/mark-paid', async (req, res, next) => {
    const tenantId       = Number(req.user && req.user.tenant_id);
    const contractId     = Number(req.params.id);
    const milestoneIndex = Number(req.params.milestoneIndex);

    if (!tenantId) return res.status(401).json({ error: 'unauthorized' });
    if (!Number.isInteger(contractId) || !Number.isInteger(milestoneIndex) || milestoneIndex < 0) {
      return res.status(400).json({ error: 'invalid path params' });
    }

    const {
      payment_method,
      payment_ref,
      payment_notes,
      paid_at,
    } = req.body || {};

    if (!payment_method || !VALID_PAYMENT_METHODS.has(payment_method)) {
      return res.status(400).json({
        error: 'invalid payment_method',
        allowed: [...VALID_PAYMENT_METHODS],
      });
    }

    const paidAtTs = paid_at ? new Date(paid_at) : new Date();
    if (Number.isNaN(paidAtTs.getTime())) {
      return res.status(400).json({ error: 'invalid paid_at' });
    }

    try {
      const bundle = await loadContractInvoiceBundle(tenantId, contractId, milestoneIndex);
      if (bundle.notFound) {
        return res.status(404).json({ error: `${bundle.notFound} not found` });
      }

      const { invoice, contract } = bundle;

      if (invoice.status === 'paid') {
        return res.status(409).json({
          error: 'already_paid',
          paid_at: invoice.paid_at,
        });
      }
      if (invoice.status === 'cancelled' || invoice.status === 'void') {
        return res.status(409).json({
          error: 'invoice_finalized',
          status: invoice.status,
        });
      }

      // Persist. We set amount_paid = amount (full payment). If the tenant
      // needs partial-payment tracking via this endpoint, extend later.
      const { rows: updated } = await pool.query(
        `UPDATE contract_invoices
            SET status         = 'paid',
                amount_paid    = amount,
                paid_at        = $1,
                payment_method = $2,
                payment_ref    = $3,
                payment_notes  = $4,
                updated_at     = NOW()
          WHERE id = $5 AND tenant_id = $6
          RETURNING *`,
        [
          paidAtTs.toISOString(),
          payment_method,
          payment_ref  || null,
          payment_notes || null,
          invoice.id, tenantId,
        ]
      );

      // If this invoice was already sent via Stripe, tell Stripe it's paid.
      // Fire-and-forget — the webhook will also reconcile.
      if (invoice.stripe_invoice_id) {
        markStripeInvoicePaidOutOfBand(invoice.stripe_invoice_id)
          .catch((err) => logger.warn({
            stripeInvoiceId: invoice.stripe_invoice_id, err: err && err.message,
          }, 'mark-paid: Stripe paid_out_of_band failed (non-fatal)'));
      }

      logger.info({
        tenantId, contractId, milestoneIndex,
        paymentMethod: payment_method,
      }, 'contract invoice marked paid');

      return res.json({ ok: true, invoice: updated[0] });
    } catch (err) {
      logger.error({ tenantId, contractId, milestoneIndex, err: err && err.message },
                   'mark-paid failed');
      return next(err);
    }
  });
};
