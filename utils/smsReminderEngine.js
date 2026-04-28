'use strict';

// utils/smsReminderEngine.js
// ---------------------------------------------------------------------------
// SMS booking reminder engine (H3.5.2).
//
// Called by POST /api/sms-reminder-job (secured by SMS_REMINDER_JOB_SECRET).
// Should be triggered every 15 minutes via a cron job (Render cron or equivalent).
//
// Reminder schedule:
//   24h  — booking starts between 23h and 25h from now
//   1h   — booking starts between 30m and 90m from now
//
// Deduplication via per-booking timestamp columns:
//   bookings.reminder_sent_24h — set after 24h reminder sent
//   bookings.reminder_sent_1h  — set after 1h reminder sent
//
// All reminders triple-gated at send time:
//   1. Tenant has 'sms_notifications' feature (Pro plan)
//   2. Tenant has Twilio credentials configured
//   3. Customer has a phone number
//
// Auto-skips: cancelled bookings excluded by status filter; pending bookings
// excluded (only 'confirmed' bookings get reminders); past bookings naturally
// outside the time window.
//
// Runtime characteristics:
//   - Partial indexes on bookings filter to only pending-reminder rows
//   - Per-booking processing is independent; one failure doesn't stop others
//   - Each send timestamps the booking atomically after success (no dedup race)
// ---------------------------------------------------------------------------

const db     = require('../db');
const logger = require('./logger');
const { sendBookingReminder } = require('./twilioSms');
const { shouldSendSMS } = require('./notificationGates'); // D5: 3-gate composer (plan + creds + per-event toggle)

// ---------------------------------------------------------------------------
// Window config — how wide to catch bookings relative to "now".
// Wider than cron interval so missed runs don't leave bookings unreminded.
// ---------------------------------------------------------------------------

const WINDOW_24H = {
  minMinutesAhead: 23 * 60, // 23h
  maxMinutesAhead: 25 * 60, // 25h
  stampColumn:     'reminder_sent_24h',
  windowType:      '24h',
};

const WINDOW_1H = {
  minMinutesAhead: 30,      // 0.5h
  maxMinutesAhead: 90,      // 1.5h
  stampColumn:     'reminder_sent_1h',
  windowType:      '1h',
};

// ---------------------------------------------------------------------------
// Main entrypoint — called by route handler
// ---------------------------------------------------------------------------

async function runSmsReminderEngine() {
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
  logger.info({ elapsedMs, ...results }, 'SMS reminder engine run complete');
  return { elapsedMs, ...results };
}

// ---------------------------------------------------------------------------
// Process a single reminder window (24h or 1h)
// ---------------------------------------------------------------------------

async function processWindow(window) {
  const { minMinutesAhead, maxMinutesAhead, stampColumn, windowType } = window;
  const stats = { processed: 0, sent: 0, skipped: 0, failed: 0 };

  // Load candidate bookings: not yet reminded in this window, confirmed,
  // starting within the window. Join customer for phone, service for name,
  // resource for name, tenant for name + timezone.
  const { rows } = await db.query(
    `
    SELECT b.id, b.tenant_id, b.start_time, b.status,
           b.booking_code,
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
      // D5: 3-gate check (plan + creds + per-event toggle). Replaces the
      // pre-D5 separate hasFeature() and isTwilioEnabledForTenant() calls.
      // The eventKind matches the windowType so a tenant can disable just
      // the 24h or just the 1h reminder.
      const eventKind = windowType === '1h' ? 'reminder_1h' : 'reminder_24h';
      const gate = await shouldSendSMS(booking.tenant_id, eventKind);
      if (!gate.ok) {
        stats.skipped++;
        continue;
      }

      // All gates passed — send
      const sendResult = await sendBookingReminder({
        booking: {
          customer_phone: booking.customer_phone,
          customer_name:  booking.customer_name,
          booking_code:   booking.booking_code,
          service_name:   booking.service_name,
          resource_name:  booking.resource_name,
          start_time:     booking.start_time,
          // For nightly bookings we could also surface checkin_date, but
          // since H3.5.2 is v1, we stick to start_time which time-slot
          // bookings always have.
        },
        tenantName:     booking.tenant_name || 'Flexrz',
        tenantTimezone: booking.tenant_timezone || 'Asia/Amman',
        tenantId:       booking.tenant_id,
        windowType,
      });

      if (sendResult.ok) {
        // Stamp the booking so we don't re-send. Note: this happens AFTER the
        // send completes. If the server crashes between send and stamp, the
        // same reminder may fire twice on the next cron. Trade-off: losing
        // an SMS is worse than duplicating one. Acceptable.
        await db.query(
          `UPDATE bookings SET ${stampColumn} = NOW() WHERE id = $1`,
          [booking.id]
        );
        stats.sent++;
        logger.info(
          { bookingId: booking.id, windowType, msgSid: sendResult.messageSid },
          'SMS reminder sent'
        );
      } else {
        stats.failed++;
        logger.warn(
          { bookingId: booking.id, windowType, reason: sendResult.reason },
          'SMS reminder send failed — will retry next run'
        );
        // Do NOT stamp on failure — we want the next cron run to retry.
      }
    } catch (err) {
      stats.failed++;
      logger.error(
        { err: err.message, bookingId: booking.id, windowType },
        'SMS reminder unhandled error'
      );
    }
  }

  return stats;
}

module.exports = { runSmsReminderEngine };
