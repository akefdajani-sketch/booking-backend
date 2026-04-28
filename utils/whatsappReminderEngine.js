'use strict';

// utils/whatsappReminderEngine.js
// ---------------------------------------------------------------------------
// WhatsApp booking reminder engine (H3.5.3).
// Mirror of utils/smsReminderEngine.js — see that file for full design notes.
// Differences:
//   - Gates on 'whatsapp_notifications' instead of 'sms_notifications'
//   - Uses isWhatsAppEnabledForTenant instead of isTwilioEnabledForTenant
//   - Uses wa_reminder_sent_24h / wa_reminder_sent_1h columns (not shared
//     with SMS — tenants with both channels get both reminders)
// ---------------------------------------------------------------------------

const db     = require('../db');
const logger = require('./logger');
const { sendBookingReminder } = require('./whatsapp');
const { shouldSendWA } = require('./notificationGates'); // D5: 3-gate composer (plan + creds + per-event toggle)

const WINDOW_24H = {
  minMinutesAhead: 23 * 60,
  maxMinutesAhead: 25 * 60,
  stampColumn:     'wa_reminder_sent_24h',
  windowType:      '24h',
};

const WINDOW_1H = {
  minMinutesAhead: 30,
  maxMinutesAhead: 90,
  stampColumn:     'wa_reminder_sent_1h',
  windowType:      '1h',
};

async function runWhatsappReminderEngine() {
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
  logger.info({ elapsedMs, ...results }, 'WhatsApp reminder engine run complete');
  return { elapsedMs, ...results };
}

async function processWindow(window) {
  const { minMinutesAhead, maxMinutesAhead, stampColumn, windowType } = window;
  const stats = { processed: 0, sent: 0, skipped: 0, failed: 0 };

  const { rows } = await db.query(
    `
    SELECT b.id, b.tenant_id, b.start_time, b.status, b.booking_code,
           c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
           s.name AS service_name,
           r.name AS resource_name,
           t.name AS tenant_name,
           t.branding->>'timezone' AS tenant_timezone
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN services s ON s.id = b.service_id
    LEFT JOIN resources r ON r.id = b.resource_id
    JOIN tenants t ON t.id = b.tenant_id
    WHERE b.status = 'confirmed'
      AND b.${stampColumn} IS NULL
      AND b.start_time >= NOW() + ($1 || ' minutes')::interval
      AND b.start_time <  NOW() + ($2 || ' minutes')::interval
      AND c.phone IS NOT NULL
      AND c.phone <> ''
    ORDER BY b.start_time ASC
    LIMIT 500
    `,
    [String(minMinutesAhead), String(maxMinutesAhead)]
  );

  stats.processed = rows.length;

  for (const booking of rows) {
    try {
      // D5: 3-gate check (plan + creds + per-event toggle).
      const eventKind = windowType === '1h' ? 'reminder_1h' : 'reminder_24h';
      const gate = await shouldSendWA(booking.tenant_id, eventKind);
      if (!gate.ok) { stats.skipped++; continue; }

      const sendResult = await sendBookingReminder({
        booking: {
          customer_phone: booking.customer_phone,
          customer_name:  booking.customer_name,
          booking_code:   booking.booking_code,
          service_name:   booking.service_name,
          resource_name:  booking.resource_name,
          start_time:     booking.start_time,
        },
        tenantName:     booking.tenant_name || 'Flexrz',
        tenantTimezone: booking.tenant_timezone || 'Asia/Amman',
        tenantId:       booking.tenant_id,
        windowType,
      });

      if (sendResult.ok) {
        await db.query(
          `UPDATE bookings SET ${stampColumn} = NOW() WHERE id = $1`,
          [booking.id]
        );
        stats.sent++;
        logger.info({ bookingId: booking.id, windowType }, 'WhatsApp reminder sent');
      } else {
        stats.failed++;
        logger.warn(
          { bookingId: booking.id, windowType, reason: sendResult.reason },
          'WhatsApp reminder send failed — will retry next run'
        );
      }
    } catch (err) {
      stats.failed++;
      logger.error(
        { err: err.message, bookingId: booking.id, windowType },
        'WhatsApp reminder unhandled error'
      );
    }
  }

  return stats;
}

module.exports = { runWhatsappReminderEngine };
