'use strict';

// utils/whatsapp.js
// ---------------------------------------------------------------------------
// WhatsApp Business Cloud API integration.
//
// Uses Meta's official Cloud API (no third-party provider needed).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/
//
// Credentials are resolved per-tenant from the DB first (WA-1), falling back
// to env vars for backward compatibility:
//   WHATSAPP_ACCESS_TOKEN      — fallback permanent system user token
//   WHATSAPP_PHONE_NUMBER_ID   — fallback Phone Number ID
//
// Message types we send:
//   1. booking_confirmation  — sent immediately after a booking is created
//   2. payment_link          — sent when owner creates a payment link
//   3. payment_received      — sent when payment is marked as paid
// ---------------------------------------------------------------------------

const https  = require('https');
const logger = require('./logger');
const { getWhatsAppCredentials } = require('./whatsappCredentials');

const META_API_VERSION = 'v19.0';

// ---------------------------------------------------------------------------
// Core: send a WhatsApp message via Meta Cloud API
// tenantId is optional — if provided, DB credentials are tried first.
// ---------------------------------------------------------------------------

async function sendMessage({ to, message, messageType = 'text', tenantId = null }) {
  const creds = await getWhatsAppCredentials(tenantId);

  if (!creds) {
    logger.warn({ to, tenantId }, 'WhatsApp not configured — no credentials in DB or env vars');
    return { ok: false, reason: 'not_configured' };
  }

  const { accessToken, phoneNumberId } = creds;

  // Normalise phone number — Meta requires international format without +
  const phone = normalisePhone(to);
  if (!phone) {
    logger.warn({ to }, 'WhatsApp: invalid phone number, skipping');
    return { ok: false, reason: 'invalid_phone' };
  }

  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                phone,
    type:              'text',
    text:              { preview_url: false, body: message },
  });

  try {
    const result = await httpPost(
      `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/messages`,
      { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body
    );

    if (result.statusCode >= 200 && result.statusCode < 300) {
      const data = JSON.parse(result.body);
      const messageId = data?.messages?.[0]?.id || null;
      logger.info({ to: phone, messageId }, 'WhatsApp message sent');
      return { ok: true, messageId, phone };
    }

    logger.warn({ to: phone, status: result.statusCode, body: result.body }, 'WhatsApp API error');
    return { ok: false, reason: 'api_error', status: result.statusCode };
  } catch (err) {
    logger.error({ err, to: phone }, 'WhatsApp send failed');
    return { ok: false, reason: 'network_error' };
  }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/**
 * Booking confirmation message — sent to customer after booking is created.
 */
function buildBookingConfirmationMessage({ tenantName, customerName, bookingCode, resourceName, checkinDate, checkoutDate, nightsCount, startTime, serviceName, paymentUrl, amountDue, currency, bookingUrl, timezone = 'Asia/Amman' }) {
  // bookingUrl is a plain-text URL — WhatsApp auto-makes it tappable.
  const firstName = (customerName || 'Guest').split(' ')[0];

  if (checkinDate && checkoutDate) {
    // Nightly booking
    return [
      `✅ Booking confirmed — ${tenantName}`,
      ``,
      `Hi ${firstName},`,
      `Your reservation has been confirmed.`,
      ``,
      `🏠 Property: ${resourceName || serviceName || 'Property'}`,
      `📅 Check-in:  ${formatDate(checkinDate, timezone)}`,
      `📅 Check-out: ${formatDate(checkoutDate, timezone)}`,
      nightsCount ? `🌙 Nights: ${nightsCount}` : '',
      ``,
      bookingCode ? `📋 *${bookingCode}*` : '',
      bookingUrl  ? bookingUrl : '',
      ``,
      paymentUrl && amountDue ? `💳 Payment due: *${formatAmount(amountDue, currency)}*` : null,
      paymentUrl ? `Pay securely here: ${paymentUrl}` : null,
      paymentUrl ? `` : null,
      `Please save this message for your records. We look forward to welcoming you!`,
    ].filter(l => l !== null).join('\n');
  }

  // Timeslot booking
  return [
    `✅ Booking confirmed — ${tenantName}`,
    ``,
    `Hi ${firstName},`,
    `Your booking has been confirmed.`,
    ``,
    serviceName  ? `🏷️ Service: ${serviceName}` : '',
    resourceName ? `📍 At: ${resourceName}` : '',
    startTime    ? `🕐 Time: ${formatDateTime(startTime, timezone)}` : '',
    ``,
    bookingCode ? `📋 *${bookingCode}*` : '',
    bookingUrl  ? bookingUrl : '',
    ``,
    paymentUrl && amountDue ? `💳 Payment due: *${formatAmount(amountDue, currency)}*` : null,
    paymentUrl ? `Pay securely here: ${paymentUrl}` : null,
    paymentUrl ? `` : null,
    `See you there!`,
  ].filter(l => l !== null).join('\n');
}

/**
 * Payment link message — sent when owner creates a payment link for a guest.
 */
function buildPaymentLinkMessage({ tenantName, customerName, bookingCode, resourceName, checkinDate, checkoutDate, amountDue, currency, paymentUrl, timezone = 'Asia/Amman' }) {
  const firstName = (customerName || 'Guest').split(' ')[0];
  const amount    = formatAmount(amountDue, currency);

  return [
    `💳 Payment request — ${tenantName}`,
    ``,
    `Hi ${firstName},`,
    `You have a payment of *${amount}* due for your upcoming stay.`,
    ``,
    resourceName ? `🏠 Property: ${resourceName}` : '',
    checkinDate  ? `📅 ${formatDate(checkinDate, timezone)} → ${formatDate(checkoutDate, timezone)}` : '',
    bookingCode  ? `📋 Reference: ${bookingCode}` : '',
    ``,
    `Pay securely here:`,
    `${paymentUrl}`,
    ``,
    `This link accepts card, CliQ, or cash. If you have any questions, please reply to this message.`,
  ].filter(l => l !== null).join('\n');
}

/**
 * Payment received message — sent when payment is recorded.
 */
function buildPaymentReceivedMessage({ tenantName, customerName, bookingCode, amountPaid, currency, resourceName, checkinDate, timezone = 'Asia/Amman' }) {
  const firstName = (customerName || 'Guest').split(' ')[0];
  const amount    = formatAmount(amountPaid, currency);

  return [
    `✅ Payment received — ${tenantName}`,
    ``,
    `Hi ${firstName},`,
    `We've received your payment of *${amount}*. Thank you!`,
    ``,
    resourceName ? `🏠 ${resourceName}` : '',
    checkinDate  ? `📅 Check-in: ${formatDate(checkinDate, timezone)}` : '',
    bookingCode  ? `📋 Reference: ${bookingCode}` : '',
    ``,
    `Your booking is confirmed and fully paid. We look forward to your stay! 🙏`,
  ].filter(l => l !== null).join('\n');
}

// ---------------------------------------------------------------------------
// High-level send functions (used by routes)
// ---------------------------------------------------------------------------

/**
 * Send booking confirmation WhatsApp to customer.
 * Non-fatal — booking proceeds even if WhatsApp fails.
 */
async function sendBookingConfirmation({ booking, tenantName, tenantTimezone = 'Asia/Amman', tenantId = null, paymentUrl, amountDue, currency, bookingUrl }) {
  const phone = booking.customer_phone;
  if (!phone) return { ok: false, reason: 'no_phone' };

  const message = buildBookingConfirmationMessage({
    tenantName,
    customerName:  booking.customer_name,
    bookingCode:   booking.booking_code,
    resourceName:  booking.resource_name,
    serviceName:   booking.service_name,
    checkinDate:   booking.checkin_date,
    checkoutDate:  booking.checkout_date,
    nightsCount:   booking.nights_count,
    startTime:     booking.start_time,
    paymentUrl,
    amountDue,
    currency,
    bookingUrl,
    timezone:      tenantTimezone,
  });

  return sendMessage({ to: phone, message, tenantId });
}

/**
 * Send payment link to customer via WhatsApp.
 */
async function sendPaymentLink({ customerPhone, customerName, tenantName, tenantId = null, bookingCode, resourceName, checkinDate, checkoutDate, amountDue, currency, paymentUrl }) {
  if (!customerPhone) return { ok: false, reason: 'no_phone' };

  const message = buildPaymentLinkMessage({
    tenantName, customerName, bookingCode, resourceName,
    checkinDate, checkoutDate, amountDue, currency, paymentUrl,
  });

  return sendMessage({ to: customerPhone, message, tenantId });
}

/**
 * Send payment received confirmation to customer.
 */
async function sendPaymentReceived({ customerPhone, customerName, tenantName, tenantId = null, bookingCode, amountPaid, currency, resourceName, checkinDate }) {
  if (!customerPhone) return { ok: false, reason: 'no_phone' };

  const message = buildPaymentReceivedMessage({
    tenantName, customerName, bookingCode, amountPaid, currency, resourceName, checkinDate,
  });

  return sendMessage({ to: customerPhone, message, tenantId });
}

/**
 * Send booking reminder WhatsApp (H3.5.3).
 * windowType: '24h' or '1h' — affects template copy.
 * Non-fatal — caller handles the setImmediate wrapper.
 *
 * Gating is caller's responsibility:
 *   - hasFeature(tenantId, 'whatsapp_notifications') — Pro plan gate
 *   - isWhatsAppEnabledForTenant(tenantId) — credentials check
 *   - customer has phone
 */
async function sendBookingReminder({
  booking,
  tenantName,
  tenantTimezone = 'Asia/Amman',
  tenantId = null,
  windowType = '24h',
}) {
  const phone = booking.customer_phone;
  if (!phone) return { ok: false, reason: 'no_phone' };

  const message = buildBookingReminderMessage({
    tenantName,
    customerName: booking.customer_name,
    bookingCode:  booking.booking_code,
    resourceName: booking.resource_name,
    serviceName:  booking.service_name,
    checkinDate:  booking.checkin_date,
    startTime:    booking.start_time,
    timezone:     tenantTimezone,
    windowType,
  });

  return sendMessage({ to: phone, message, tenantId });
}

function buildBookingReminderMessage({
  tenantName,
  customerName,
  bookingCode,
  resourceName,
  serviceName,
  checkinDate,
  startTime,
  timezone,
  windowType,
}) {
  const greeting = customerName ? `Hi ${customerName},` : 'Hi,';
  const is1h = windowType === '1h';

  const opener = is1h
    ? `${greeting} quick reminder — your booking at *${tenantName}* starts soon.`
    : `${greeting} friendly reminder — you have a booking tomorrow at *${tenantName}*.`;

  const lines = [opener, ''];
  if (bookingCode) lines.push(`*Reference:* ${bookingCode}`);

  if (checkinDate) {
    lines.push(`*When:* ${formatDate(checkinDate, timezone)}`);
  } else if (startTime) {
    lines.push(`*When:* ${formatDate(startTime, timezone)} at ${formatDateTime(startTime, timezone).split(' ').pop()}`);
  }

  const what = [serviceName, resourceName].filter(Boolean).join(' · ');
  if (what) lines.push(`*Details:* ${what}`);

  lines.push('');
  if (is1h) {
    lines.push('See you soon! 👋');
  } else {
    lines.push('Need to reschedule? Just reply to this message.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalisePhone(raw) {
  if (!raw) return null;
  // Remove everything except digits and leading +
  let s = String(raw).trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  // Strip leading 00 (international dialling prefix, e.g. 00962 → 962)
  if (s.startsWith('00')) s = s.slice(2);
  // Must be 7–15 digits (E.164 without the +)
  if (!/^\d{7,15}$/.test(s)) return null;
  return s;
}

function formatDate(d, tz = 'Asia/Amman') {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
  } catch { return String(d).slice(0, 10); }
}

function formatDateTime(d, tz = 'Asia/Amman') {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: tz,
    });
  } catch { return String(d); }
}

function formatAmount(amount, currency = 'JOD') {
  try {
    return new Intl.NumberFormat('en-JO', { style: 'currency', currency, maximumFractionDigits: 3 }).format(Number(amount));
  } catch { return `${currency} ${Number(amount).toFixed(3)}`; }
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname + u.search,
      method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('WhatsApp API timeout')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Check if WhatsApp is configured (used by routes to decide whether to send)
// ---------------------------------------------------------------------------

// isWhatsAppConfigured checks env vars only — used as a fast synchronous guard.
// For tenant-aware checks use isWhatsAppEnabledForTenant(tenantId) from whatsappCredentials.js
function isWhatsAppConfigured() {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

module.exports = {
  sendMessage,
  sendBookingConfirmation,
  sendBookingReminder,
  sendPaymentLink,
  sendPaymentReceived,
  isWhatsAppConfigured,
  // Exported for testing
  buildBookingConfirmationMessage,
  buildBookingReminderMessage,
  buildPaymentLinkMessage,
  buildPaymentReceivedMessage,
  normalisePhone,
};
