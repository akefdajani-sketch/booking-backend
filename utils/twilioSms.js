'use strict';

// utils/twilioSms.js
// ---------------------------------------------------------------------------
// Twilio Programmable Messaging (SMS) integration.
//
// Mirrors utils/whatsapp.js exactly — same shape of sendMessage() + high-level
// send functions + helpers. Uses Twilio's REST API directly (no Twilio SDK
// dependency, same minimal-deps approach as whatsapp.js using Node https).
//
// Credentials are resolved per-tenant from the DB first (via utils/twilioCredentials),
// falling back to env vars for backward compat:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER           (either this or messaging service SID must be set)
//   TWILIO_MESSAGING_SERVICE_SID (preferred — handles short code / alphanumeric)
//
// Message types we send:
//   1. booking_confirmation   — sent immediately after a booking is created
//   2. booking_cancellation   — sent when a booking is cancelled
//   3. booking_reminder       — sent from a scheduled reminder job (deferred to H3.5.2)
//
// Feature-gating: SMS is a Pro-plan feature. Call sites MUST check
//   await hasFeature(tenantId, "sms_notifications")
// before invoking any of the send functions below. This utility does NOT check
// entitlements itself — it's a dumb sender, and the gate is the caller's
// responsibility (same pattern as utils/whatsapp.js).
// ---------------------------------------------------------------------------

const https  = require('https');
const { URL } = require('url');
const querystring = require('querystring');
const logger = require('./logger');
const { getTwilioCredentials } = require('./twilioCredentials');

const TWILIO_API_HOST = 'api.twilio.com';
const TWILIO_API_VERSION = '2010-04-01';

// ---------------------------------------------------------------------------
// Core: send an SMS via Twilio REST API
// tenantId is optional — if provided, DB credentials are tried first.
// ---------------------------------------------------------------------------

async function sendMessage({ to, message, tenantId = null }) {
  const creds = await getTwilioCredentials(tenantId).catch((err) => {
    logger.warn({ err: err?.message, tenantId }, 'Twilio: credential load failed');
    return null;
  });

  if (!creds) {
    logger.warn({ to, tenantId }, 'Twilio not configured — no credentials in DB or env vars');
    return { ok: false, reason: 'not_configured' };
  }

  const { accountSid, authToken, fromNumber, messagingServiceSid } = creds;

  if (!accountSid || !authToken) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!fromNumber && !messagingServiceSid) {
    logger.warn({ tenantId }, 'Twilio: neither fromNumber nor messagingServiceSid is configured');
    return { ok: false, reason: 'no_sender' };
  }

  const phone = normalisePhone(to);
  if (!phone) {
    logger.warn({ to }, 'Twilio: invalid phone number, skipping');
    return { ok: false, reason: 'invalid_phone' };
  }

  // Twilio wants E.164 with the leading + re-added.
  const toE164 = `+${phone}`;

  // Build form body — Twilio uses application/x-www-form-urlencoded, not JSON.
  const formData = {
    To: toE164,
    Body: message,
  };
  if (messagingServiceSid) {
    formData.MessagingServiceSid = messagingServiceSid;
  } else {
    formData.From = fromNumber;
  }
  const body = querystring.stringify(formData);

  // Twilio uses HTTP Basic auth with AccountSid:AuthToken.
  const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const path = `/${TWILIO_API_VERSION}/Accounts/${accountSid}/Messages.json`;

  try {
    const result = await httpPost(
      `https://${TWILIO_API_HOST}${path}`,
      {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body
    );

    if (result.statusCode >= 200 && result.statusCode < 300) {
      let messageSid = null;
      try {
        const data = JSON.parse(result.body);
        messageSid = data?.sid || null;
      } catch { /* ok */ }
      logger.info({ to: toE164, messageSid, tenantId }, 'Twilio SMS sent');
      return { ok: true, messageSid, phone: toE164 };
    }

    // Non-2xx: try to surface Twilio's own error code/message
    let twilioCode = null;
    let twilioMsg = null;
    try {
      const parsed = JSON.parse(result.body);
      twilioCode = parsed?.code || null;
      twilioMsg  = parsed?.message || null;
    } catch { /* ok */ }

    logger.warn(
      { to: toE164, tenantId, status: result.statusCode, twilioCode, twilioMsg },
      'Twilio API error'
    );
    return {
      ok: false,
      reason: 'api_error',
      status: result.statusCode,
      twilioCode,
      twilioMsg,
    };
  } catch (err) {
    logger.error({ err: err.message, to: toE164, tenantId }, 'Twilio send failed');
    return { ok: false, reason: 'network_error' };
  }
}

// ---------------------------------------------------------------------------
// High-level send functions (used by routes)
// ---------------------------------------------------------------------------

/**
 * Send booking confirmation SMS to customer.
 * Non-fatal — booking proceeds even if SMS fails.
 *
 * Caller is responsible for:
 *   - Checking hasFeature(tenantId, "sms_notifications") (Pro-plan gate)
 *   - Checking the customer actually has a phone number
 *   - Handling the non-blocking setImmediate() wrapper
 */
async function sendBookingConfirmation({
  booking,
  tenantName,
  tenantTimezone = 'Asia/Amman',
  tenantId = null,
  bookingUrl = null,
  // G2-PL-4 Track A: optional payment link params. When paymentUrl is set,
  // it REPLACES bookingUrl in the rendered SMS (one URL only — paid Twilio
  // multi-segment is fine, but UX-wise single CTA converts better).
  paymentUrl = null,
  amountDue = null,
  currency = null,
}) {
  const phone = booking.customer_phone;
  if (!phone) return { ok: false, reason: 'no_phone' };

  const message = buildBookingConfirmationMessage({
    tenantName,
    customerName: booking.customer_name,
    bookingCode:  booking.booking_code,
    resourceName: booking.resource_name,
    serviceName:  booking.service_name,
    checkinDate:  booking.checkin_date,
    checkoutDate: booking.checkout_date,
    nightsCount:  booking.nights_count,
    startTime:    booking.start_time,
    bookingUrl,
    paymentUrl,
    amountDue,
    currency:     currency || booking.currency_code || 'JOD',
    timezone:     tenantTimezone,
  });

  return sendMessage({ to: phone, message, tenantId });
}

/**
 * Send booking cancellation SMS to customer.
 */
async function sendBookingCancellation({
  booking,
  tenantName,
  tenantTimezone = 'Asia/Amman',
  tenantId = null,
}) {
  const phone = booking.customer_phone;
  if (!phone) return { ok: false, reason: 'no_phone' };

  const message = buildBookingCancellationMessage({
    tenantName,
    customerName: booking.customer_name,
    bookingCode:  booking.booking_code,
    resourceName: booking.resource_name,
    serviceName:  booking.service_name,
    checkinDate:  booking.checkin_date,
    startTime:    booking.start_time,
    timezone:     tenantTimezone,
  });

  return sendMessage({ to: phone, message, tenantId });
}

/**
 * Send booking reminder SMS to customer.
 * windowType: '24h' or '1h' — affects template copy.
 *
 * H3.5.2: triggered by smsReminderEngine, which handles dedup via
 * bookings.reminder_sent_24h / reminder_sent_1h columns.
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

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildBookingConfirmationMessage({
  tenantName,
  customerName,
  bookingCode,
  resourceName,
  serviceName,
  checkinDate,
  checkoutDate,
  nightsCount,
  startTime,
  bookingUrl,
  // G2-PL-4 Track A
  paymentUrl,
  amountDue,
  currency,
  timezone,
}) {
  const lines = [];
  const greeting = customerName ? `Hi ${customerName},` : 'Hi,';
  lines.push(`${greeting} your booking at ${tenantName} is confirmed.`);

  if (bookingCode) lines.push(`Reference: ${bookingCode}`);

  // Nightly vs time-slot booking
  if (checkinDate && checkoutDate) {
    const nights = nightsCount ? ` (${nightsCount} night${nightsCount === 1 ? '' : 's'})` : '';
    lines.push(`${formatDate(checkinDate, timezone)} → ${formatDate(checkoutDate, timezone)}${nights}`);
  } else if (startTime) {
    lines.push(`${formatDate(startTime, timezone)} at ${formatTime(startTime, timezone)}`);
  }

  if (resourceName && serviceName) {
    lines.push(`${serviceName} · ${resourceName}`);
  } else if (resourceName) {
    lines.push(resourceName);
  } else if (serviceName) {
    lines.push(serviceName);
  }

  // G2-PL-4 Track A: payment link wins. Pending link → render with amount
  // preview and OMIT booking URL. No payment link → booking URL.
  if (paymentUrl) {
    if (amountDue != null && Number.isFinite(Number(amountDue))) {
      lines.push(`Pay ${formatAmount(amountDue, currency)}: ${paymentUrl}`);
    } else {
      lines.push(`Pay: ${paymentUrl}`);
    }
  } else if (bookingUrl) {
    lines.push(bookingUrl);
  }

  return lines.join('\n');
}

function buildBookingCancellationMessage({
  tenantName,
  customerName,
  bookingCode,
  resourceName,
  serviceName,
  checkinDate,
  startTime,
  timezone,
}) {
  const greeting = customerName ? `Hi ${customerName},` : 'Hi,';
  const ref = bookingCode ? ` (${bookingCode})` : '';
  const when = checkinDate
    ? formatDate(checkinDate, timezone)
    : (startTime ? `${formatDate(startTime, timezone)} at ${formatTime(startTime, timezone)}` : '');
  const what = [serviceName, resourceName].filter(Boolean).join(' · ');

  const lines = [
    `${greeting} your booking at ${tenantName}${ref} has been cancelled.`,
  ];
  if (when || what) lines.push([when, what].filter(Boolean).join(' — '));
  lines.push('Contact us if this was unexpected.');
  return lines.join('\n');
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

  // Tone varies by urgency — 24h is friendly reminder, 1h is "heads up, soon!"
  const opener = is1h
    ? `${greeting} quick reminder — your booking at ${tenantName} starts soon.`
    : `${greeting} reminder — you have a booking tomorrow at ${tenantName}.`;

  const lines = [opener];
  if (bookingCode) lines.push(`Reference: ${bookingCode}`);

  if (checkinDate) {
    lines.push(formatDate(checkinDate, timezone));
  } else if (startTime) {
    lines.push(`${formatDate(startTime, timezone)} at ${formatTime(startTime, timezone)}`);
  }

  const what = [serviceName, resourceName].filter(Boolean).join(' · ');
  if (what) lines.push(what);

  if (is1h) {
    lines.push('See you soon!');
  } else {
    lines.push('Reply to this message to reschedule.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalisePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (!/^\d{7,15}$/.test(s)) return null;
  return s;
}

function formatDate(d, tz = 'Asia/Amman') {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: tz,
    });
  } catch { return String(d).slice(0, 10); }
}

function formatTime(d, tz = 'Asia/Amman') {
  if (!d) return '';
  try {
    return new Date(d).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
    });
  } catch { return String(d).slice(11, 16); }
}

// G2-PL-4 Track A: amount + currency preview for SMS payment line.
// Plain ASCII only (no emoji) to keep messages within GSM-7 segments.
// JOD has 3 decimals (fils), USD/EUR has 2 — use 2 unless code is JOD/KWD/BHD/OMR/IQD.
function formatAmount(amount, currency = 'JOD') {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '';
  const cur = (currency || 'JOD').toString().toUpperCase();
  const threeDecimal = ['JOD', 'KWD', 'BHD', 'OMR', 'IQD', 'TND', 'LYD'];
  const dp = threeDecimal.includes(cur) ? 3 : 2;
  return `${num.toFixed(dp)} ${cur}`;
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { reject(err); return; }

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers:  { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function isTwilioConfiguredViaEnv() {
  return (
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    (!!process.env.TWILIO_FROM_NUMBER || !!process.env.TWILIO_MESSAGING_SERVICE_SID)
  );
}

module.exports = {
  sendMessage,
  sendBookingConfirmation,
  sendBookingCancellation,
  sendBookingReminder,
  // Exposed for tests / debugging
  buildBookingConfirmationMessage,
  buildBookingCancellationMessage,
  buildBookingReminderMessage,
  normalisePhone,
  formatAmount,
  isTwilioConfiguredViaEnv,
};
