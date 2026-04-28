'use strict';

// utils/emailReminderEngine.js
// PR H (Customer booking emails).
//
// Email booking reminder engine. Mirrors utils/smsReminderEngine.js exactly —
// same windows, same dedup pattern, same per-booking gate. Only the channel
// is different.
//
// Called by POST /api/email-reminder-job (secured by EMAIL_REMINDER_JOB_SECRET).
// Should be triggered every 15 minutes via a cron job.
//
// Reminder schedule:
//   24h — booking starts between 23h and 25h from now
//   1h  — booking starts between 30m and 90m from now
//
// Deduplication via per-booking timestamp columns (migration 055):
//   bookings.email_reminder_sent_24h
//   bookings.email_reminder_sent_1h
//
// All reminders triple-gated at send time via shouldSendEmail():
//   1. Tenant has 'email_reminders' feature (Growth+ plan)
//   2. Platform RESEND_API_KEY is configured
//   3. Per-tenant per-event toggle is on (email_reminder_24h_enabled etc.)
//
// Plus: customer.email must exist (no point sending to NULL).
//
// Single-failure isolation: per-booking try/catch — one booking's send error
// doesn't stop the rest.

const db     = require('../db');
const logger = require('./logger');
const { sendEmail } = require('./email');
const { shouldSendEmail } = require('./notificationGates');
const {
  renderBookingReminder24h,
  renderBookingReminder1h,
} = require('./customerBookingEmailTemplates');

const APP_BASE = (process.env.APP_BASE_URL || 'https://app.flexrz.com').replace(/\/+$/, '');

const WINDOW_24H = {
  minMinutesAhead: 23 * 60,
  maxMinutesAhead: 25 * 60,
  stampColumn:     'email_reminder_sent_24h',
  windowType:      '24h',
  eventKind:       'reminder_24h',
  render:          renderBookingReminder24h,
  kindLog:         'booking_reminder_24h',
};

const WINDOW_1H = {
  minMinutesAhead: 30,
  maxMinutesAhead: 90,
  stampColumn:     'email_reminder_sent_1h',
  windowType:      '1h',
  eventKind:       'reminder_1h',
  render:          renderBookingReminder1h,
  kindLog:         'booking_reminder_1h',
};

async function runEmailReminderEngine() {
  const started = Date.now();
  const results = { processed: 0, sent: 0, skipped: 0, failed: 0, details: [] };

  for (const window of [WINDOW_24H, WINDOW_1H]) {
    const r = await processWindow(window);
    results.processed += r.processed;
    results.sent      += r.sent;
    results.skipped   += r.skipped;
    results.failed    += r.failed;
    results.details.push({ windowType: window.windowType, ...r });
  }

  const elapsedMs = Date.now() - started;
  logger.info({ elapsedMs, ...results }, 'Email reminder engine run complete');
  return { elapsedMs, ...results };
}

async function processWindow(window) {
  const { minMinutesAhead, maxMinutesAhead, stampColumn, windowType, eventKind, render, kindLog } = window;
  const stats = { processed: 0, sent: 0, skipped: 0, failed: 0 };

  // Same join pattern as smsReminderEngine; only difference is filtering on
  // c.email IS NOT NULL instead of c.phone, and selecting the email-specific
  // dedup stamp column.
  const { rows } = await db.query(
    `
    SELECT b.id, b.tenant_id, b.start_time, b.status,
           b.booking_code,
           c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
           s.name AS service_name,
           r.name AS resource_name,
           t.name AS tenant_name,
           t.slug AS tenant_slug,
           t.branding->>'timezone' AS tenant_timezone,
           t.branding->>'primary_color' AS tenant_accent_color
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN services s ON s.id = b.service_id
    LEFT JOIN resources r ON r.id = b.resource_id
    JOIN tenants t ON t.id = b.tenant_id
    WHERE b.status = 'confirmed'
      AND b.${stampColumn} IS NULL
      AND b.start_time >= NOW() + ($1 || ' minutes')::interval
      AND b.start_time <  NOW() + ($2 || ' minutes')::interval
      AND c.email IS NOT NULL
      AND c.email <> ''
    ORDER BY b.start_time ASC
    LIMIT 500
    `,
    [String(minMinutesAhead), String(maxMinutesAhead)]
  );

  stats.processed = rows.length;

  for (const booking of rows) {
    try {
      // 3-gate check — same shape as SMS/WA paths.
      const gate = await shouldSendEmail(booking.tenant_id, eventKind);
      if (!gate.ok) {
        stats.skipped++;
        continue;
      }

      const tpl = render({
        tenantName:     booking.tenant_name || 'Flexrz',
        tenantTimezone: booking.tenant_timezone || 'Asia/Amman',
        bookingUrl:     booking.tenant_slug ? `${APP_BASE}/book/${encodeURIComponent(booking.tenant_slug)}` : null,
        customerName:   booking.customer_name,
        serviceName:    booking.service_name,
        resourceName:   booking.resource_name,
        startTime:      booking.start_time,
        bookingCode:    booking.booking_code,
        accentColor:    booking.tenant_accent_color,
      });

      const sendResult = await sendEmail({
        kind: kindLog,
        to: booking.customer_email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        tenantId: booking.tenant_id,
        meta: { booking_id: booking.id, window: windowType },
      });

      if (sendResult.ok && sendResult.status === 'sent') {
        // Stamp AFTER successful send. Same trade-off as SMS engine: a crash
        // between send and stamp causes a double-send next cron, which is
        // strictly preferable to a missed reminder.
        await db.query(
          `UPDATE bookings SET ${stampColumn} = NOW() WHERE id = $1`,
          [booking.id]
        );
        stats.sent++;
        logger.info(
          { bookingId: booking.id, windowType, messageId: sendResult.messageId },
          'Email reminder sent'
        );
      } else if (sendResult.status === 'skipped') {
        // sendEmail decided not to send (kill switch / no API key). Don't
        // stamp — when conditions change, the next cron will pick it up.
        stats.skipped++;
      } else {
        stats.failed++;
        logger.warn(
          { bookingId: booking.id, windowType, error: sendResult.error },
          'Email reminder send failed — will retry next run'
        );
      }
    } catch (err) {
      stats.failed++;
      logger.error(
        { err: err.message, bookingId: booking.id, windowType },
        'Email reminder unhandled error'
      );
    }
  }

  return stats;
}

module.exports = { runEmailReminderEngine };
