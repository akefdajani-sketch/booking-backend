'use strict';

// utils/contractInvoiceSms.js
// G2-PL-4: SMS dispatcher for contract invoice notifications.
//
// Mirrors utils/contractInvoiceWhatsapp.js. Same windowType machine
// ('sign' | 't3' | 'due' | 'overdue'), same field names, same paymentUrl
// support. Different transport: utils/twilioSms.js sendMessage().
//
// SMS is the fallback channel when WhatsApp delivery fails or the customer
// doesn't have WA. Also sent in parallel with WA for high-priority events
// like signing confirmation and overdue reminders so the customer can't
// miss them.
//
// Cost note: SMS to Jordan via Twilio is roughly $0.05/segment. Templates
// here are tuned to ≤2 segments at typical input lengths (one segment
// = 70 chars when content includes Unicode like the → arrow, or 160 chars
// for pure GSM-7 ASCII).

const { sendMessage } = require('./twilioSms');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Helpers — kept local to mirror the WA file, but use the same conventions.
// ---------------------------------------------------------------------------

function formatAmount(amount, currency = 'JOD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  const cur = (currency || 'JOD').toString().toUpperCase();
  const threeDecimal = ['JOD', 'KWD', 'BHD', 'OMR', 'IQD', 'TND', 'LYD'];
  const dp = threeDecimal.includes(cur) ? 3 : 2;
  return `${cur} ${n.toFixed(dp)}`;
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

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

/**
 * Build the SMS body. Compact compared to the WhatsApp version because:
 *   - SMS billed per segment (70/160 chars), shorter = cheaper
 *   - SMS doesn't render multi-line as nicely as WA, so we use single
 *     paragraphs separated by newlines instead of double-newlines
 *
 * windowType: 'sign' | 't3' | 'due' | 'overdue'
 *
 * Examples (using JOD currency, 3-decimal):
 *
 *   sign:
 *     Hi John, your lease at Aqaba Book is signed. Contract: AQB-CON-2026-0001
 *     First invoice: JOD 750.000 due 1 May 2026
 *     Pay: https://app.flexrz.com/pay-invoice/abc123
 *
 *   t3:
 *     Hi John, payment for Month 2 (JOD 375.000) on AQB-CON-2026-0001 is due
 *     in 3 days (1 Jun 2026)
 *     Pay: https://app.flexrz.com/pay-invoice/abc123
 *
 *   due:
 *     Hi John, payment for Month 2 (JOD 375.000) is due TODAY
 *     Pay: https://app.flexrz.com/pay-invoice/abc123
 *
 *   overdue:
 *     Hi John, payment for Month 2 (JOD 375.000) on AQB-CON-2026-0001 is
 *     overdue (was due 1 Jun 2026)
 *     Pay: https://app.flexrz.com/pay-invoice/abc123
 */
function buildContractInvoiceSmsMessage({
  tenantName,
  customerName,
  contractNumber,
  milestoneLabel,
  amount,
  currency,
  dueDate,
  timezone = 'Asia/Amman',
  windowType = 't3',
  paymentUrl = null,
}) {
  const dueStr = formatDate(dueDate, timezone);
  const amountStr = formatAmount(amount, currency || 'JOD');
  const firstName = (customerName && customerName.trim())
    ? customerName.trim().split(' ')[0]
    : null;
  const greet = firstName ? `Hi ${firstName},` : 'Hi,';
  const milestone = milestoneLabel || 'this installment';

  const lines = [];

  if (windowType === 'sign') {
    lines.push(`${greet} your lease at ${tenantName || 'your host'} is signed. Contract: ${contractNumber}`);
    lines.push(`First invoice: ${amountStr} due ${dueStr}`);
  } else if (windowType === 'due') {
    lines.push(`${greet} payment for ${milestone} (${amountStr}) is due TODAY`);
  } else if (windowType === 'overdue') {
    lines.push(`${greet} payment for ${milestone} (${amountStr}) on ${contractNumber} is overdue (was due ${dueStr})`);
  } else {
    // 't3' — default
    lines.push(`${greet} payment for ${milestone} (${amountStr}) on ${contractNumber} is due in 3 days (${dueStr})`);
  }

  if (paymentUrl) lines.push(`Pay: ${paymentUrl}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Send a contract invoice SMS reminder.
 * Returns { ok: boolean, reason?, messageSid? }. Fire-and-forget — never throws.
 */
async function sendContractInvoiceSms({
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
  windowType = 't3',
  paymentUrl = null,
}) {
  try {
    if (!customerPhone || !customerPhone.trim()) {
      return { ok: false, reason: 'no_phone' };
    }
    const message = buildContractInvoiceSmsMessage({
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
      tenantId,
    });

    return result;
  } catch (err) {
    logger.error(
      { err: err.message, contractNumber, milestoneLabel, windowType },
      'sendContractInvoiceSms unhandled error'
    );
    return { ok: false, reason: 'unhandled_error', error: err.message };
  }
}

module.exports = {
  sendContractInvoiceSms,
  // Exposed for tests
  buildContractInvoiceSmsMessage,
  formatAmount,
  formatDate,
};
