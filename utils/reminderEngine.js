'use strict';

// utils/reminderEngine.js
// ---------------------------------------------------------------------------
// Smart WhatsApp reminder engine for unpaid rental payment links.
//
// Called by POST /api/reminder-job (secured by REMINDER_JOB_SECRET).
// Should be triggered every hour via a cron job (Render cron, cron-job.org, etc.)
//
// Reminder schedule (all subject to link still being 'pending' or 'partial'):
//
//   followup_2d  — 2 days after link created,  no expiry restriction
//   followup_5d  — 5 days after link created,  no expiry restriction
//   expiry_2d    — 2 days before link expires  (only if expires_at is set)
//   expiry_1d    — 1 day  before link expires  (only if expires_at is set)
//   expiry_day   — on the day link expires     (only if expires_at is set)
//
// Deduplication: payment_link_reminders has UNIQUE(link_id, reminder_type),
// so each reminder type is sent at most once per link.
//
// Auto-stop: only 'pending' and 'partial' links are queried — paid/cancelled
// links are ignored automatically. No extra logic needed.
// ---------------------------------------------------------------------------

const db     = require('../db');
const logger = require('./logger');
const { sendPaymentReminder } = require('./whatsapp');
const { getWhatsAppCredentials } = require('./whatsappCredentials');

const FRONTEND_URL = process.env.BOOKING_FRONTEND_URL || 'https://flexrz.com';

// ---------------------------------------------------------------------------
// Map reminder type → urgency level for the message tone
// ---------------------------------------------------------------------------
const URGENCY_MAP = {
  followup_2d: 'gentle',
  followup_5d: 'gentle',
  expiry_2d:   'urgent',
  expiry_1d:   'urgent',
  expiry_day:  'final',
};

// ---------------------------------------------------------------------------
// Build all due reminders for a single payment link row.
// Returns an array of reminder_type strings that should be sent now.
// ---------------------------------------------------------------------------
function getDueReminderTypes(link, alreadySent, nowMs) {
  const createdMs  = new Date(link.created_at).getTime();
  const expiryMs   = link.expires_at ? new Date(link.expires_at).getTime() : null;
  const dayMs      = 24 * 60 * 60 * 1000;
  const due        = [];

  // followup_2d: >= 2 days since creation
  if (!alreadySent.has('followup_2d') && (nowMs - createdMs) >= 2 * dayMs) {
    due.push('followup_2d');
  }

  // followup_5d: >= 5 days since creation
  if (!alreadySent.has('followup_5d') && (nowMs - createdMs) >= 5 * dayMs) {
    due.push('followup_5d');
  }

  if (expiryMs) {
    const msUntilExpiry = expiryMs - nowMs;

    // expiry_2d: within 2–3 days of expiry
    if (!alreadySent.has('expiry_2d') && msUntilExpiry <= 2 * dayMs && msUntilExpiry > dayMs) {
      due.push('expiry_2d');
    }

    // expiry_1d: within 1 day of expiry (but more than 0)
    if (!alreadySent.has('expiry_1d') && msUntilExpiry <= dayMs && msUntilExpiry > 0) {
      due.push('expiry_1d');
    }

    // expiry_day: past expiry but link not yet auto-expired (grace window — same day)
    if (!alreadySent.has('expiry_day') && msUntilExpiry <= 0 && msUntilExpiry >= -dayMs) {
      due.push('expiry_day');
    }
  }

  return due;
}

// ---------------------------------------------------------------------------
// Main engine function — called by the job endpoint.
// Returns a summary { processed, sent, skipped, errors }.
// ---------------------------------------------------------------------------
async function runReminderEngine() {
  const nowMs  = Date.now();
  const result = { processed: 0, sent: 0, skipped: 0, errors: 0 };

  // Fetch all pending/partial payment links that have a customer phone
  // Join through bookings to get customer data and resource info
  const { rows: links } = await db.query(`
    SELECT
      l.id,
      l.tenant_id,
      l.token,
      l.booking_id,
      l.amount_requested,
      l.currency_code,
      l.description,
      l.allowed_methods,
      l.expires_at,
      l.created_at,
      l.status,
      b.booking_code,
      b.customer_name,
      b.customer_phone,
      b.checkin_date,
      b.checkout_date,
      b.resource_name,
      t.name AS tenant_name,
      t.slug AS tenant_slug
    FROM rental_payment_links l
    JOIN bookings b ON b.id = l.booking_id
    JOIN tenants  t ON t.id = l.tenant_id
    WHERE l.status IN ('pending', 'partial')
      AND b.customer_phone IS NOT NULL
      AND b.customer_phone != ''
      AND (l.expires_at IS NULL OR l.expires_at > NOW() - INTERVAL '1 day')
    ORDER BY l.created_at ASC
  `);

  if (links.length === 0) {
    logger.info('ReminderEngine: no pending payment links found');
    return result;
  }

  // Batch-fetch all already-sent reminders for these links
  const linkIds = links.map(l => l.id);
  const { rows: sentRows } = await db.query(
    `SELECT link_id, reminder_type FROM payment_link_reminders WHERE link_id = ANY($1)`,
    [linkIds]
  );

  // Build a map: linkId → Set of sent reminder types
  const sentMap = new Map();
  for (const row of sentRows) {
    if (!sentMap.has(row.link_id)) sentMap.set(row.link_id, new Set());
    sentMap.get(row.link_id).add(row.reminder_type);
  }

  for (const link of links) {
    result.processed++;
    const alreadySent  = sentMap.get(link.id) || new Set();
    const dueTypes     = getDueReminderTypes(link, alreadySent, nowMs);

    if (dueTypes.length === 0) {
      result.skipped++;
      continue;
    }

    // Check WhatsApp is configured for this tenant
    let creds;
    try {
      creds = await getWhatsAppCredentials(link.tenant_id);
    } catch (_) { creds = null; }

    if (!creds) {
      logger.warn({ linkId: link.id, tenantId: link.tenant_id }, 'ReminderEngine: WhatsApp not configured for tenant, skipping');
      result.skipped++;
      continue;
    }

    const paymentUrl = `${FRONTEND_URL}/pay/${link.token}`;

    for (const reminderType of dueTypes) {
      const urgency = URGENCY_MAP[reminderType] || 'gentle';

      try {
        const waResult = await sendPaymentReminder({
          customerPhone: link.customer_phone,
          customerName:  link.customer_name,
          tenantName:    link.tenant_name,
          tenantId:      link.tenant_id,
          bookingCode:   link.booking_code,
          resourceName:  link.resource_name,
          checkinDate:   link.checkin_date,
          checkoutDate:  link.checkout_date,
          amountDue:     link.amount_requested,
          currency:      link.currency_code,
          paymentUrl,
          urgency,
        });

        // Log the reminder (UNIQUE constraint prevents duplicates)
        await db.query(
          `INSERT INTO payment_link_reminders
             (link_id, tenant_id, reminder_type, sent_to, whatsapp_msg_id, ok, error_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (link_id, reminder_type) DO NOTHING`,
          [
            link.id,
            link.tenant_id,
            reminderType,
            waResult.phone || link.customer_phone,
            waResult.messageId || null,
            waResult.ok,
            waResult.ok ? null : (waResult.reason || 'unknown'),
          ]
        );

        if (waResult.ok) {
          result.sent++;
          logger.info({
            linkId: link.id,
            bookingCode: link.booking_code,
            reminderType,
            phone: waResult.phone,
            msgId: waResult.messageId,
          }, 'ReminderEngine: reminder sent');
        } else {
          result.errors++;
          logger.warn({
            linkId: link.id,
            reminderType,
            reason: waResult.reason,
          }, 'ReminderEngine: reminder send failed');
        }
      } catch (err) {
        result.errors++;
        logger.error({ err, linkId: link.id, reminderType }, 'ReminderEngine: unexpected error sending reminder');

        // Still log the attempt so we don't retry endlessly on a broken link
        try {
          await db.query(
            `INSERT INTO payment_link_reminders
               (link_id, tenant_id, reminder_type, ok, error_reason)
             VALUES ($1, $2, $3, false, $4)
             ON CONFLICT (link_id, reminder_type) DO NOTHING`,
            [link.id, link.tenant_id, reminderType, String(err.message || 'error')]
          );
        } catch (_) {}
      }
    }
  }

  logger.info(result, 'ReminderEngine: run complete');
  return result;
}

module.exports = { runReminderEngine };
