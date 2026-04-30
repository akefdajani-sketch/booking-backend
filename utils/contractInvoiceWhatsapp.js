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
 * G2-PL-4: now supports three reminder windows + a sign-time confirmation
 * variant, and renders the payment portal URL when supplied.
 *
 *   windowType: 'sign' | 't3' | 'due' | 'overdue'
 *
 * Examples:
 *
 *   windowType='sign' (just signed):
 *     Welcome to Aqaba Book!
 *
 *     Hi John, your lease (AQB-CON-2026-0001) is signed.
 *     Your first invoice for Month 1 is JOD 750.000, due 1 May 2026.
 *
 *     Pay online: https://app.flexrz.com/pay-invoice/abc123
 *
 *   windowType='t3':
 *     Reminder from Aqaba Book
 *
 *     Hi John, your payment for Month 2 on contract AQB-CON-2026-0001 is
 *     due in 3 days (1 Jun 2026). Amount: JOD 375.000
 *
 *     Pay online: https://app.flexrz.com/pay-invoice/abc123
 *
 *   windowType='due':
 *     Hi John, your payment for Month 2 (JOD 375.000) is due TODAY.
 *
 *   windowType='overdue':
 *     Hi John, your payment for Month 2 (JOD 375.000) is overdue —
 *     it was due on 1 Jun 2026.
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
  // G2-PL-4
  windowType = 't3',
  paymentUrl = null,
}) {
  const dueStr = formatDate(dueDate, timezone);
  const amountStr = formatAmount(amount, currency || 'JOD');
  const namePart = (customerName && customerName.trim())
    ? `Hi ${customerName.trim().split(' ')[0]}, `
    : 'Hi, ';

  let lines;

  if (windowType === 'sign') {
    lines = [
      `Welcome to ${tenantName || 'your host'}!`,
      '',
      `${namePart}your lease (${contractNumber}) is signed.`,
      `Your first invoice for ${milestoneLabel || 'the first installment'} is ${amountStr}, due ${dueStr}.`,
    ];
  } else if (windowType === 'due') {
    lines = [
      `Reminder from ${tenantName || 'your host'}`,
      '',
      `${namePart}your payment for ${milestoneLabel || 'the next installment'} (${amountStr}) on contract ${contractNumber} is due TODAY.`,
    ];
  } else if (windowType === 'overdue') {
    lines = [
      `Payment overdue — ${tenantName || 'your host'}`,
      '',
      `${namePart}your payment for ${milestoneLabel || 'the installment'} (${amountStr}) on contract ${contractNumber} is overdue. It was due on ${dueStr}.`,
      '',
      'Please complete payment as soon as possible to keep your lease in good standing.',
    ];
  } else {
    // 't3' — default
    lines = [
      `Reminder from ${tenantName || 'your host'}`,
      '',
      `${namePart}this is a friendly reminder that your payment for ${milestoneLabel || 'the next installment'} on contract ${contractNumber} is due on ${dueStr}.`,
      '',
      `Amount: ${amountStr}`,
    ];
  }

  if (paymentUrl) {
    lines.push('');
    lines.push(`Pay online: ${paymentUrl}`);
  } else if (windowType === 't3') {
    lines.push('');
    lines.push('Please arrange payment by the due date. Thank you!');
  }

  return lines.join('\n');
}

/**
 * Send the reminder. Returns { ok: boolean, reason?, messageId? }.
 * Fire-and-forget at the caller — will never throw.
 *
 * G2-PL-4: now accepts windowType ('sign'|'t3'|'due'|'overdue') and
 * paymentUrl. Defaults to 't3' for backward compat.
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
  // G2-PL-4
  windowType = 't3',
  paymentUrl = null,
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
      windowType,
      paymentUrl,
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
      { err: err.message, contractNumber, milestoneLabel, windowType },
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
