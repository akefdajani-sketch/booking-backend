'use strict';

// utils/contractSigningNotification.js
// G2-PL-4: Sends the "lease signed" notification to the renter immediately
// after a contract transitions into 'signed' status.
//
// Called from BOTH:
//   - routes/contracts/create.js (when initial_status='signed')
//   - routes/contracts/update.js (when transitioning draft|pending_signature → signed)
//
// Behavior:
//   1. Look up the FIRST contract_invoice for this contract (lowest milestone_index)
//   2. Generate a payment link for it via getOrCreatePendingLink (idempotent)
//   3. Send WhatsApp + SMS in parallel with the link embedded
//   4. Mark contract_invoices.sign_notification_sent_at = NOW() so we don't
//      re-fire if the contract somehow re-transitions to signed (rare, but
//      possible if status was bounced)
//
// Caller is responsible for wrapping in setImmediate() — this function does
// real network calls and DB queries.

const db     = require('../db');
const logger = require('./logger');
const { hasFeature } = require('./entitlements');
const { isWhatsAppEnabledForTenant } = require('./whatsappCredentials');
const { sendContractInvoiceReminder } = require('./contractInvoiceWhatsapp');
const { sendContractInvoiceSms }      = require('./contractInvoiceSms');
const { shouldSendSMS }               = require('./notificationGates');
const { getOrCreatePendingLink }      = require('./contractInvoicePaymentLinks');

/**
 * Send signing notification for a freshly-signed contract.
 *
 * @param {Object} args
 * @param {number} args.contractId
 * @param {number} args.tenantId
 * @returns {Promise<{ok: boolean, reason?: string, waSent?: boolean, smsSent?: boolean}>}
 */
async function sendContractSigningNotification({ contractId, tenantId }) {
  try {
    if (!contractId || !tenantId) {
      return { ok: false, reason: 'missing_args' };
    }

    // 1. Pull contract + customer + tenant context. Filter to FIRST invoice
    // (lowest milestone_index) that hasn't already had a sign-notification.
    const ctxRes = await db.query(
      `
      SELECT
        c.id              AS contract_id,
        c.contract_number,
        c.tenant_id,
        c.currency_code,
        cust.name         AS customer_name,
        cust.phone        AS customer_phone,
        t.name            AS tenant_name,
        t.timezone        AS tenant_timezone,
        ci.id             AS invoice_id,
        ci.milestone_index,
        ci.milestone_label,
        ci.amount         AS invoice_amount,
        ci.due_date       AS invoice_due_date,
        ci.status         AS invoice_status,
        ci.sign_notification_sent_at
      FROM contracts c
      JOIN customers cust ON cust.id = c.customer_id AND cust.tenant_id = c.tenant_id
      JOIN tenants   t    ON t.id    = c.tenant_id
      LEFT JOIN contract_invoices ci
             ON ci.contract_id = c.id
            AND ci.status IN ('pending', 'sent', 'partial')
      WHERE c.id = $1 AND c.tenant_id = $2
      ORDER BY ci.milestone_index ASC NULLS LAST, ci.id ASC
      LIMIT 1
      `,
      [contractId, tenantId]
    );

    if (!ctxRes.rows.length) {
      return { ok: false, reason: 'contract_not_found' };
    }
    const ctx = ctxRes.rows[0];

    if (!ctx.invoice_id) {
      // Contract has no invoices yet (e.g. terminated/cancelled contract,
      // or the invoice generation failed earlier). Nothing to send.
      logger.warn(
        { contractId, tenantId, contractNumber: ctx.contract_number },
        'Signing notification skipped — no invoices on contract'
      );
      return { ok: false, reason: 'no_invoices' };
    }

    if (ctx.sign_notification_sent_at) {
      // Already sent. Idempotent guard — protects against double-send if
      // the contract bounces through signed → draft → signed.
      return { ok: false, reason: 'already_sent' };
    }

    if (!ctx.customer_phone || !ctx.customer_phone.trim()) {
      logger.warn(
        { contractId, tenantId },
        'Signing notification skipped — customer has no phone'
      );
      return { ok: false, reason: 'no_phone' };
    }

    // 2. Generate payment link for the first invoice. Idempotent.
    let paymentUrl = null;
    try {
      const link = await getOrCreatePendingLink({ contractInvoiceId: ctx.invoice_id });
      if (link && link.token) {
        const frontendUrl = process.env.FRONTEND_URL || 'https://app.flexrz.com';
        paymentUrl = `${frontendUrl}/pay-invoice/${link.token}`;
      }
    } catch (linkErr) {
      // Non-fatal — send notification without URL. The customer still gets
      // the "lease signed" message; they can pay later via reminder.
      logger.warn(
        { contractId, invoiceId: ctx.invoice_id, err: linkErr.message },
        'Could not build payment link for signing notification; sending without URL'
      );
    }

    // 3. Dispatch on both channels in parallel. Each channel checks its own
    //    gating; failed dispatch does not block the other channel.
    const commonArgs = {
      customerPhone:   ctx.customer_phone,
      customerName:    ctx.customer_name,
      tenantId:        tenantId,
      tenantName:      ctx.tenant_name || 'Flexrz',
      tenantTimezone:  ctx.tenant_timezone || 'Asia/Amman',
      contractNumber:  ctx.contract_number,
      milestoneLabel:  ctx.milestone_label,
      amount:          ctx.invoice_amount,
      currency:        ctx.currency_code || 'JOD',
      dueDate:         ctx.invoice_due_date,
      windowType:      'sign',
      paymentUrl,
    };

    let waSent = false;
    let smsSent = false;

    // WA dispatch
    try {
      const waEnabled = await hasFeature(tenantId, 'whatsapp_notifications').catch(() => false);
      const waCreds   = waEnabled
        ? await isWhatsAppEnabledForTenant(tenantId).catch(() => false)
        : false;
      if (waEnabled && waCreds) {
        const r = await sendContractInvoiceReminder(commonArgs);
        waSent = !!(r && r.ok);
      }
    } catch (waErr) {
      logger.error({ err: waErr.message, contractId }, 'Signing notification WA error');
    }

    // SMS dispatch — gate via shouldSendSMS('confirmations') because signing
    // is conceptually a confirmation event.
    try {
      const smsGate = await shouldSendSMS(tenantId, 'confirmations').catch(() => ({ ok: false }));
      if (smsGate.ok) {
        const r = await sendContractInvoiceSms(commonArgs);
        smsSent = !!(r && r.ok);
      }
    } catch (smsErr) {
      logger.error({ err: smsErr.message, contractId }, 'Signing notification SMS error');
    }

    // 4. Mark dedup flag. ANY successful channel counts. If both failed,
    //    leave the flag null so a manual retry endpoint (future) could
    //    re-fire later.
    if (waSent || smsSent) {
      await db.query(
        `UPDATE contract_invoices SET sign_notification_sent_at = NOW() WHERE id = $1`,
        [ctx.invoice_id]
      );
      logger.info(
        {
          contractId,
          contractNumber: ctx.contract_number,
          invoiceId: ctx.invoice_id,
          wa: waSent,
          sms: smsSent,
          hasPaymentUrl: !!paymentUrl,
        },
        'Contract signing notification sent'
      );
      return { ok: true, waSent, smsSent };
    }

    logger.warn(
      { contractId, contractNumber: ctx.contract_number, invoiceId: ctx.invoice_id },
      'Contract signing notification: no channels succeeded — flag NOT set, will not retry automatically'
    );
    return { ok: false, reason: 'all_channels_failed' };

  } catch (err) {
    logger.error(
      { err: err.message, contractId, tenantId },
      'sendContractSigningNotification unhandled error'
    );
    return { ok: false, reason: 'unhandled_error', error: err.message };
  }
}

module.exports = { sendContractSigningNotification };
