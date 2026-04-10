'use strict';

// utils/whatsapp.js
// ---------------------------------------------------------------------------
// WhatsApp Business Cloud API integration.
//
// Uses Meta's official Cloud API (no third-party provider needed).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/
//
// Required env vars:
//   WHATSAPP_ACCESS_TOKEN      — permanent system user token from Meta Business Manager
//   WHATSAPP_PHONE_NUMBER_ID   — Phone Number ID from Meta → WhatsApp → API Setup
//   WHATSAPP_BUSINESS_ACCOUNT_ID — optional, for account-level operations
//
// Message types we send:
//   1. booking_confirmation  — sent immediately after a booking is created
//   2. payment_link          — sent when owner creates a payment link
//   3. payment_received      — sent when payment is marked as paid
//
// All messages use template messages (required for business-initiated conversations)
// OR free-form text if within 24h customer service window.
//
// Template names must be pre-approved in Meta Business Manager.
// During development, we send plain text messages (works within 24h window).
// ---------------------------------------------------------------------------

const https  = require('https');
const logger = require('./logger');

const META_API_VERSION = 'v19.0';

// ---------------------------------------------------------------------------
// Core: send a WhatsApp message via Meta Cloud API
// ---------------------------------------------------------------------------

async function sendMessage({ to, message, messageType = 'text' }) {
  const accessToken    = process.env.WHATSAPP_ACCESS_TOKEN || '';
  const phoneNumberId  = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

  if (!accessToken || !phoneNumberId) {
    logger.warn({ to }, 'WhatsApp not configured — WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing');
    return { ok: false, reason: 'not_configured' };
  }

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
function buildBookingConfirmationMessage({ tenantName, customerName, bookingCode, resourceName, checkinDate, checkoutDate, nightsCount, startTime, serviceName }) {
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
      `📅 Check-in:  ${formatDate(checkinDate)}`,
      `📅 Check-out: ${formatDate(checkoutDate)}`,
      nightsCount ? `🌙 Nights: ${nightsCount}` : '',
      ``,
      bookingCode ? `📋 Reference: *${bookingCode}*` : '',
      ``,
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
    startTime    ? `🕐 Time: ${formatDateTime(startTime)}` : '',
    ``,
    bookingCode ? `📋 Reference: *${bookingCode}*` : '',
    ``,
    `See you there!`,
  ].filter(l => l !== null).join('\n');
}

/**
 * Payment link message — sent when owner creates a payment link for a guest.
 */
function buildPaymentLinkMessage({ tenantName, customerName, bookingCode, resourceName, checkinDate, checkoutDate, amountDue, currency, paymentUrl }) {
  const firstName = (customerName || 'Guest').split(' ')[0];
  const amount    = formatAmount(amountDue, currency);

  return [
    `💳 Payment request — ${tenantName}`,
    ``,
    `Hi ${firstName},`,
    `You have a payment of *${amount}* due for your upcoming stay.`,
    ``,
    resourceName ? `🏠 Property: ${resourceName}` : '',
    checkinDate  ? `📅 ${formatDate(checkinDate)} → ${formatDate(checkoutDate)}` : '',
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
function buildPaymentReceivedMessage({ tenantName, customerName, bookingCode, amountPaid, currency, resourceName, checkinDate }) {
  const firstName = (customerName || 'Guest').split(' ')[0];
  const amount    = formatAmount(amountPaid, currency);

  return [
    `✅ Payment received — ${tenantName}`,
    ``,
    `Hi ${firstName},`,
    `We've received your payment of *${amount}*. Thank you!`,
    ``,
    resourceName ? `🏠 ${resourceName}` : '',
    checkinDate  ? `📅 Check-in: ${formatDate(checkinDate)}` : '',
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
async function sendBookingConfirmation({ booking, tenantName }) {
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
  });

  return sendMessage({ to: phone, message });
}

/**
 * Send payment link to customer via WhatsApp.
 */
async function sendPaymentLink({ customerPhone, customerName, tenantName, bookingCode, resourceName, checkinDate, checkoutDate, amountDue, currency, paymentUrl }) {
  if (!customerPhone) return { ok: false, reason: 'no_phone' };

  const message = buildPaymentLinkMessage({
    tenantName, customerName, bookingCode, resourceName,
    checkinDate, checkoutDate, amountDue, currency, paymentUrl,
  });

  return sendMessage({ to: customerPhone, message });
}

/**
 * Send payment received confirmation to customer.
 */
async function sendPaymentReceived({ customerPhone, customerName, tenantName, bookingCode, amountPaid, currency, resourceName, checkinDate }) {
  if (!customerPhone) return { ok: false, reason: 'no_phone' };

  const message = buildPaymentReceivedMessage({
    tenantName, customerName, bookingCode, amountPaid, currency, resourceName, checkinDate,
  });

  return sendMessage({ to: customerPhone, message });
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

function formatDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return String(d).slice(0, 10); }
}

function formatDateTime(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
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

function isWhatsAppConfigured() {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

module.exports = {
  sendMessage,
  sendBookingConfirmation,
  sendPaymentLink,
  sendPaymentReceived,
  isWhatsAppConfigured,
  // Exported for testing
  buildBookingConfirmationMessage,
  buildPaymentLinkMessage,
  buildPaymentReceivedMessage,
  normalisePhone,
};
