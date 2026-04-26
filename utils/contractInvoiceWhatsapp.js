'use strict';

// utils/contractInvoiceWhatsapp.js
// G2a-S3d: Send a WhatsApp reminder for a contract invoice due soon.
//
// Uses the shared utils/whatsapp.js sendMessage() transport so per-tenant
// WhatsApp Cloud API credentials are honoured (WA-1 infrastructure).

const { sendMessage } = require('./whatsapp');
const logger = require('./logger');

/**
 * Format a money amount. Matches the 3-decimal convention used across the
 * rest of the contracts code (JOD has fils, not cents).
 */
function formatAmount(amount, currency = 'JOD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  const str = n.toFixed(3).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${str}`;
}

function formatDate(dateIso, timezone = 'Asia/Amman') {
  if (!dateIso) return '';
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return String(dateIso);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Build the reminder message body.
 *
 * Example output:
 *   Reminder from Aqaba Book
 *
 *   Hi John, this is a friendly reminder that your payment for Month 2
 *   on contract AQB-CON-2026-0001 is due on 1 Jun 2026.
 *
 *   Amount: JOD 375.000
 *
 *   Please arrange payment by the due date. Thank you!
 */
function buildContractInvoiceReminderMessage({
  tenantName,
  customerName,
  contractNumber,
  milestoneLabel,
  amount,
  currency,
  dueDate,
  timezone = 'Asia/Amman',
}) {
  const dueStr = formatDate(dueDate, timezone);
  const amountStr = formatAmount(amount, currency || 'JOD');
  const namePart = (customerName && customerName.trim()) ? `Hi ${customerName.trim().split(' ')[0]}, ` : 'Hi, ';

  return [
    `Reminder from ${tenantName || 'your host'}`,
    '',
    `${namePart}this is a friendly reminder that your payment for ${milestoneLabel || 'the next installment'} on contract ${contractNumber} is due on ${dueStr}.`,
    '',
    `Amount: ${amountStr}`,
    '',
    'Please arrange payment by the due date. Thank you!',
  ].join('\n');
}

/**
 * Send the reminder. Returns { ok: boolean, reason?, messageId? }.
 * Fire-and-forget at the caller — will never throw.
 */
async function sendContractInvoiceReminder({
  customerPhone,
  customerName,
  tenantId,
  tenantName,
  tenantTimezone,
  contractNumber,
  milestoneLabel,
  amount,
  currency,
  dueDate,
}) {
  try {
    if (!customerPhone || !customerPhone.trim()) {
      return { ok: false, reason: 'no_phone' };
    }
    const message = buildContractInvoiceReminderMessage({
      tenantName,
      customerName,
      contractNumber,
      milestoneLabel,
      amount,
      currency,
      dueDate,
      timezone: tenantTimezone || 'Asia/Amman',
    });

    const result = await sendMessage({
      to: customerPhone,
      message,
      messageType: 'text',
      tenantId,
    });

    return result;
  } catch (err) {
    logger.error(
      { err: err.message, contractNumber, milestoneLabel },
      'sendContractInvoiceReminder unhandled error'
    );
    return { ok: false, reason: 'unhandled_error', error: err.message };
  }
}

module.exports = {
  sendContractInvoiceReminder,
  // Exposed for testing
  buildContractInvoiceReminderMessage,
  formatAmount,
  formatDate,
};
