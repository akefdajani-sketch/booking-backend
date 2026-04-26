'use strict';

// utils/contractInvoiceReminderEngine.js
// G2a-S3d: Scan contract_invoices for pending/sent invoices due within the
// next N days and send one-time WhatsApp reminders.
//
// Dedup: uses contract_invoices.reminder_sent_at. Each invoice gets at most
// one reminder. When the tenant sends a second invoice later (via the main
// Stripe flow), that new invoice row is separate and starts with reminder_
// sent_at = NULL, so it'll be picked up on the next scan.
//
// Gating:
//   - tenant.rental_mode_enabled must be true
//   - tenant must have whatsapp_notifications feature entitlement
//   - tenant must have WhatsApp credentials configured
//
// Called from routes/contractInvoiceReminderJob.js (HTTP endpoint hit by
// Render cron every 15 minutes or so).

const db     = require('../db');
const logger = require('./logger');
const { hasFeature } = require('./entitlements');
const { isWhatsAppEnabledForTenant } = require('./whatsappCredentials');
const { sendContractInvoiceReminder } = require('./contractInvoiceWhatsapp');

/**
 * Days-ahead window for the scan. Invoices with a due_date falling in the
 * range [today, today + LEAD_TIME_DAYS] that haven't been reminded are picked.
 */
const LEAD_TIME_DAYS = 3;

/** Max rows to process per run (defensive). */
const PER_RUN_LIMIT = 500;

async function runContractInvoiceReminderEngine({ leadTimeDays = LEAD_TIME_DAYS, limit = PER_RUN_LIMIT } = {}) {
  const started = Date.now();
  const stats = { processed: 0, sent: 0, skipped: 0, failed: 0 };

  const { rows } = await db.query(
    `
    SELECT ci.id                 AS invoice_id,
           ci.tenant_id,
           ci.contract_id,
           ci.milestone_index,
           ci.milestone_label,
           ci.amount,
           ci.due_date,
           ci.status,
           c.contract_number,
           c.currency_code,
           cust.id               AS customer_id,
           cust.name             AS customer_name,
           cust.phone            AS customer_phone,
           t.name                AS tenant_name,
           t.branding->>'timezone' AS tenant_timezone,
           t.rental_mode_enabled
    FROM contract_invoices ci
    JOIN contracts c    ON c.id    = ci.contract_id   AND c.tenant_id   = ci.tenant_id
    JOIN customers cust ON cust.id = c.customer_id    AND cust.tenant_id = ci.tenant_id
    JOIN tenants   t    ON t.id    = ci.tenant_id
    WHERE ci.reminder_sent_at IS NULL
      AND ci.status IN ('pending', 'sent')
      AND ci.due_date IS NOT NULL
      AND ci.due_date >= CURRENT_DATE
      AND ci.due_date <= CURRENT_DATE + ($1 || ' days')::interval
      AND cust.phone IS NOT NULL
      AND cust.phone <> ''
      AND t.rental_mode_enabled IS TRUE
    ORDER BY ci.due_date ASC
    LIMIT $2
    `,
    [String(leadTimeDays), limit]
  );

  stats.processed = rows.length;

  for (const invoice of rows) {
    try {
      const waEnabled = await hasFeature(invoice.tenant_id, 'whatsapp_notifications').catch(() => false);
      if (!waEnabled) { stats.skipped++; continue; }

      const credsEnabled = await isWhatsAppEnabledForTenant(invoice.tenant_id).catch(() => false);
      if (!credsEnabled) { stats.skipped++; continue; }

      const sendResult = await sendContractInvoiceReminder({
        customerPhone:   invoice.customer_phone,
        customerName:    invoice.customer_name,
        tenantId:        invoice.tenant_id,
        tenantName:      invoice.tenant_name || 'Flexrz',
        tenantTimezone:  invoice.tenant_timezone || 'Asia/Amman',
        contractNumber:  invoice.contract_number,
        milestoneLabel:  invoice.milestone_label,
        amount:          invoice.amount,
        currency:        invoice.currency_code || 'JOD',
        dueDate:         invoice.due_date,
      });

      if (sendResult && sendResult.ok) {
        await db.query(
          `UPDATE contract_invoices SET reminder_sent_at = NOW() WHERE id = $1`,
          [invoice.invoice_id]
        );
        stats.sent++;
        logger.info(
          { invoiceId: invoice.invoice_id, contractNumber: invoice.contract_number },
          'contract invoice reminder sent'
        );
      } else {
        stats.failed++;
        logger.warn(
          { invoiceId: invoice.invoice_id, reason: sendResult && sendResult.reason },
          'contract invoice reminder send failed — will retry next run'
        );
      }
    } catch (err) {
      stats.failed++;
      logger.error(
        { err: err.message, invoiceId: invoice.invoice_id },
        'contract invoice reminder unhandled error'
      );
    }
  }

  const elapsedMs = Date.now() - started;
  logger.info({ elapsedMs, ...stats }, 'Contract invoice reminder engine run complete');
  return { elapsedMs, ...stats };
}

module.exports = { runContractInvoiceReminderEngine };
