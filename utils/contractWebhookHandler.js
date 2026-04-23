'use strict';

// utils/contractWebhookHandler.js
// G2a-2: Route Stripe invoice.* events to contract_invoices rows.
//
// Called from routes/stripeWebhook.js BEFORE the existing tenant_invoices
// path. Returns true if this event was handled as a contract invoice event;
// false if it wasn't (and caller should continue to tenant_invoices logic).

const { pool } = require('../db');
const logger = require('./logger');

/**
 * Looks at stripeInvoice.metadata.flexrz_channel to detect contract events.
 * If 'contract', updates the matching contract_invoices row and returns true.
 * Otherwise returns false so the caller falls through to tenant billing.
 */
async function handleContractInvoiceEvent(eventType, stripeInvoice) {
  const meta = stripeInvoice && stripeInvoice.metadata ? stripeInvoice.metadata : {};
  if (meta.flexrz_channel !== 'contract') return false;

  const contractInvoiceId = Number(meta.contract_invoice_id);
  const tenantId          = Number(meta.tenant_id);
  if (!Number.isInteger(contractInvoiceId) || !Number.isInteger(tenantId)) {
    logger.warn({ eventType, stripeInvoiceId: stripeInvoice.id, meta },
                'contract webhook: invalid metadata, skipping');
    return true; // claim it (don't fall through) to avoid tenant_invoices confusion
  }

  const { rows } = await pool.query(
    `SELECT id, status FROM contract_invoices WHERE id = $1 AND tenant_id = $2`,
    [contractInvoiceId, tenantId]
  );
  if (rows.length === 0) {
    logger.warn({ eventType, contractInvoiceId, tenantId },
                'contract webhook: contract_invoices row not found');
    return true;
  }

  const existing = rows[0];

  switch (eventType) {
    case 'invoice.paid': {
      // amount_paid from Stripe is in minor units; we already have amount in NUMERIC(12,3).
      // Mark fully paid and record the timestamp from Stripe's transition, if present.
      const paidAtEpoch = stripeInvoice.status_transitions
        && stripeInvoice.status_transitions.paid_at;
      const paidAt = paidAtEpoch ? new Date(paidAtEpoch * 1000) : new Date();

      await pool.query(
        `UPDATE contract_invoices
            SET status        = 'paid',
                amount_paid   = amount,
                paid_at       = $1,
                payment_method = COALESCE(payment_method, 'stripe'),
                updated_at    = NOW()
          WHERE id = $2 AND tenant_id = $3`,
        [paidAt.toISOString(), contractInvoiceId, tenantId]
      );

      logger.info({ contractInvoiceId, tenantId, stripeInvoiceId: stripeInvoice.id },
                  'contract invoice marked paid via webhook');
      return true;
    }

    case 'invoice.payment_failed': {
      // Keep status='sent' (not moving to 'cancelled' — Stripe retries automatically).
      // Log a payment_notes entry for audit.
      const reason = (stripeInvoice.last_finalization_error && stripeInvoice.last_finalization_error.message)
        || (stripeInvoice.last_payment_error && stripeInvoice.last_payment_error.message)
        || 'Payment attempt failed';

      await pool.query(
        `UPDATE contract_invoices
            SET payment_notes = CONCAT(
                  COALESCE(payment_notes, ''),
                  CASE WHEN payment_notes IS NULL OR payment_notes = '' THEN '' ELSE E'\n' END,
                  '[', to_char(NOW(), 'YYYY-MM-DD HH24:MI'), '] Stripe: ', $1
                ),
                updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3`,
        [reason, contractInvoiceId, tenantId]
      );

      logger.warn({ contractInvoiceId, tenantId, reason },
                  'contract invoice payment failed (Stripe will retry)');
      return true;
    }

    case 'invoice.voided': {
      if (existing.status === 'paid') {
        logger.warn({ contractInvoiceId, stripeInvoiceId: stripeInvoice.id },
                    'invoice.voided received but contract_invoice is already paid — ignoring');
        return true;
      }
      await pool.query(
        `UPDATE contract_invoices
            SET status     = 'void',
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND status <> 'paid'`,
        [contractInvoiceId, tenantId]
      );
      logger.info({ contractInvoiceId, tenantId }, 'contract invoice voided via webhook');
      return true;
    }

    case 'invoice.finalized':
    case 'invoice.sent':
      // Informational only — we flipped status to 'sent' when we called
      // sendInvoice on our side. No further action needed.
      return true;

    default:
      // Unhandled invoice.* event — we still claim it so tenant_invoices
      // doesn't process a contract invoice.
      logger.info({ eventType, contractInvoiceId }, 'contract webhook: unhandled event type');
      return true;
  }
}

module.exports = { handleContractInvoiceEvent };
