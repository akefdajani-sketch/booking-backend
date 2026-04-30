'use strict';

// utils/contractInvoiceReminderEngine.js
// G2-PL-4: Three-window reminder engine for contract invoices.
//
// Replaces the pre-G2-PL-4 single-shot engine. Each invoice now gets up to
// THREE reminder dispatches over its lifecycle:
//
//   T-3  → 3 days before due_date
//   DUE  → on due_date
//   OVERDUE → 5 days after due_date (configurable via OVERDUE_DAYS)
//
// Dedup is per-window via three independent timestamp columns (added in
// migration 058):
//   contract_invoices.reminder_t3_sent_at
//   contract_invoices.reminder_due_sent_at
//   contract_invoices.reminder_overdue_sent_at
//
// Each successful dispatch sets its column to NOW(); subsequent runs skip.
// Once a window fires successfully, we never re-fire it for the same invoice
// (no spam if the cron triggers multiple times in a day).
//
// On every run, EACH eligible invoice gets:
//   1. WhatsApp dispatch (if WA enabled + creds present)
//   2. SMS dispatch (if SMS enabled + creds present)
//   3. A payment link generated if not yet present (via getOrCreatePendingLink)
//   4. The portal URL embedded in BOTH WA and SMS messages
//
// Either channel succeeding sets the dedup flag. If only WA succeeded but SMS
// failed, we still mark the window as sent — partial delivery is acceptable
// (the customer got it on at least one channel). Re-running won't help.
//
// Gating per channel:
//   - WA: tenant.rental_mode_enabled, hasFeature('whatsapp_notifications'),
//         isWhatsAppEnabledForTenant
//   - SMS: hasFeature('sms_notifications'), isSmsEnabledForTenant via shouldSendSMS
//
// Invoices already paid/void/cancelled are excluded by the SQL filter.

const db     = require('../db');
const logger = require('./logger');
const { hasFeature } = require('./entitlements');
const { isWhatsAppEnabledForTenant } = require('./whatsappCredentials');
const { sendContractInvoiceReminder } = require('./contractInvoiceWhatsapp');
const { sendContractInvoiceSms }      = require('./contractInvoiceSms');
const { shouldSendSMS }               = require('./notificationGates');
const { getOrCreatePendingLink }      = require('./contractInvoicePaymentLinks');

/** Number of days after due_date that the overdue reminder fires. */
const OVERDUE_DAYS = 5;

/** Max rows per window per run. Defensive. */
const PER_WINDOW_LIMIT = 250;

// ---------------------------------------------------------------------------
// Window definitions — declarative so the engine loop reads cleanly.
// ---------------------------------------------------------------------------

const WINDOWS = [
  {
    type: 't3',
    label: 'T-3',
    // Eligible: due_date is between today+1 and today+3 (inclusive),
    // and reminder_t3_sent_at is null.
    sqlWhere: `
      ci.reminder_t3_sent_at IS NULL
      AND ci.due_date >= CURRENT_DATE
      AND ci.due_date <= CURRENT_DATE + INTERVAL '3 days'
    `,
    flagColumn: 'reminder_t3_sent_at',
  },
  {
    type: 'due',
    label: 'Due',
    // Eligible: due_date is today, reminder_due_sent_at is null.
    sqlWhere: `
      ci.reminder_due_sent_at IS NULL
      AND ci.due_date = CURRENT_DATE
    `,
    flagColumn: 'reminder_due_sent_at',
  },
  {
    type: 'overdue',
    label: 'Overdue',
    // Eligible: due_date is OVERDUE_DAYS days in the past (exact day, not
    // "any day past N"), and reminder_overdue_sent_at is null. We pin to
    // a single day so we don't accidentally spam customers daily after
    // the overdue window. If the cron misses a day (unlikely), we widen
    // the floor by checking <=, but cap re-fires by the dedup flag.
    sqlWhere: `
      ci.reminder_overdue_sent_at IS NULL
      AND ci.due_date <= CURRENT_DATE - INTERVAL '${OVERDUE_DAYS} days'
      AND ci.due_date >= CURRENT_DATE - INTERVAL '${OVERDUE_DAYS + 30} days'
    `,
    flagColumn: 'reminder_overdue_sent_at',
  },
];

// ---------------------------------------------------------------------------
// Main entry — runs all three windows
// ---------------------------------------------------------------------------

async function runContractInvoiceReminderEngine({ limit = PER_WINDOW_LIMIT } = {}) {
  const started = Date.now();
  const stats = {
    windows: {},
    totals: { processed: 0, waSent: 0, smsSent: 0, anySent: 0, skipped: 0, failed: 0 },
  };

  for (const window of WINDOWS) {
    const wstats = await runOneWindow(window, limit);
    stats.windows[window.type] = wstats;
    stats.totals.processed += wstats.processed;
    stats.totals.waSent    += wstats.waSent;
    stats.totals.smsSent   += wstats.smsSent;
    stats.totals.anySent   += wstats.anySent;
    stats.totals.skipped   += wstats.skipped;
    stats.totals.failed    += wstats.failed;
  }

  const elapsedMs = Date.now() - started;
  logger.info({ elapsedMs, ...stats.totals }, 'Contract invoice reminder engine run complete');
  return { elapsedMs, ...stats };
}

// ---------------------------------------------------------------------------
// Per-window scan + dispatch
// ---------------------------------------------------------------------------

async function runOneWindow(window, limit) {
  const stats = { window: window.type, processed: 0, waSent: 0, smsSent: 0, anySent: 0, skipped: 0, failed: 0 };

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
           t.timezone            AS tenant_timezone,
           t.rental_mode_enabled
    FROM contract_invoices ci
    JOIN contracts c    ON c.id    = ci.contract_id   AND c.tenant_id   = ci.tenant_id
    JOIN customers cust ON cust.id = c.customer_id    AND cust.tenant_id = ci.tenant_id
    JOIN tenants   t    ON t.id    = ci.tenant_id
    WHERE ${window.sqlWhere}
      AND ci.status IN ('pending', 'sent', 'partial')
      AND cust.phone IS NOT NULL
      AND cust.phone <> ''
      AND t.rental_mode_enabled IS TRUE
    ORDER BY ci.due_date ASC
    LIMIT $1
    `,
    [limit]
  );

  stats.processed = rows.length;

  for (const invoice of rows) {
    try {
      // Step 1: build/reuse a pending payment link so the message has a URL.
      // getOrCreatePendingLink is idempotent — same token reused on every run.
      let paymentUrl = null;
      try {
        const link = await getOrCreatePendingLink({ contractInvoiceId: invoice.invoice_id });
        if (link && link.token) {
          const frontendUrl = process.env.FRONTEND_URL || 'https://app.flexrz.com';
          paymentUrl = `${frontendUrl}/pay-invoice/${link.token}`;
        }
      } catch (linkErr) {
        // Non-fatal — send reminder without URL. Most likely cause is the
        // invoice flipped to paid/void between scan and now (race condition
        // with /record-payment), in which case skipping is correct.
        logger.warn(
          { invoiceId: invoice.invoice_id, err: linkErr.message },
          'Could not build payment link for reminder; sending without URL'
        );
      }

      // Step 2: WA dispatch — gated by plan + creds.
      let waOk = false;
      let waAttempted = false;
      const waEnabled = await hasFeature(invoice.tenant_id, 'whatsapp_notifications').catch(() => false);
      const waCreds   = waEnabled
        ? await isWhatsAppEnabledForTenant(invoice.tenant_id).catch(() => false)
        : false;
      if (waEnabled && waCreds) {
        waAttempted = true;
        const waResult = await sendContractInvoiceReminder({
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
          windowType:      window.type,
          paymentUrl,
        });
        waOk = !!(waResult && waResult.ok);
        if (waOk) stats.waSent++;
      }

      // Step 3: SMS dispatch — gated by plan + creds via shouldSendSMS.
      let smsOk = false;
      let smsAttempted = false;
      const smsGate = await shouldSendSMS(invoice.tenant_id, 'reminders').catch(() => ({ ok: false }));
      if (smsGate.ok) {
        smsAttempted = true;
        const smsResult = await sendContractInvoiceSms({
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
          windowType:      window.type,
          paymentUrl,
        });
        smsOk = !!(smsResult && smsResult.ok);
        if (smsOk) stats.smsSent++;
      }

      // Step 4: dedup. ANY successful channel marks the window as sent.
      // If both failed, we leave the flag null so next run retries.
      if (waOk || smsOk) {
        await db.query(
          `UPDATE contract_invoices SET ${window.flagColumn} = NOW() WHERE id = $1`,
          [invoice.invoice_id]
        );
        stats.anySent++;
        logger.info(
          {
            invoiceId: invoice.invoice_id,
            contractNumber: invoice.contract_number,
            window: window.type,
            wa: waOk,
            sms: smsOk,
            hasPaymentUrl: !!paymentUrl,
          },
          'Contract invoice reminder sent'
        );
      } else if (!waAttempted && !smsAttempted) {
        // Neither channel was even attempted (tenant has neither WA creds
        // nor SMS gate). Don't keep retrying — mark as sent to skip on
        // subsequent runs.
        await db.query(
          `UPDATE contract_invoices SET ${window.flagColumn} = NOW() WHERE id = $1`,
          [invoice.invoice_id]
        );
        stats.skipped++;
        logger.info(
          { invoiceId: invoice.invoice_id, window: window.type },
          'Contract invoice reminder window skipped (no notification channels enabled)'
        );
      } else {
        // At least one channel was attempted but both failed. Leave the flag
        // null so the next cron run retries.
        stats.failed++;
        logger.warn(
          {
            invoiceId: invoice.invoice_id,
            window: window.type,
            waAttempted,
            smsAttempted,
          },
          'Contract invoice reminder send failed on all channels — will retry next run'
        );
      }
    } catch (err) {
      stats.failed++;
      logger.error(
        { err: err.message, invoiceId: invoice.invoice_id, window: window.type },
        'Contract invoice reminder unhandled error'
      );
    }
  }

  return stats;
}

module.exports = { runContractInvoiceReminderEngine, OVERDUE_DAYS, WINDOWS };
