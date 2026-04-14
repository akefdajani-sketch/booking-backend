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
const { sendPaymentReminder, sendMessage } = require('./whatsapp');
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
      r.name AS resource_name,
      t.name AS tenant_name,
      t.slug AS tenant_slug
    FROM rental_payment_links l
    JOIN bookings b ON b.id = l.booking_id
    LEFT JOIN resources r ON r.id = b.resource_id
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


// ---------------------------------------------------------------------------
// PR-LEASE-1: Lease renewal reminder schedule
//
//   renewal_30d — 30 days before lease_end
//   renewal_14d — 14 days before lease_end
//   renewal_7d  — 7 days before lease_end
//   renewal_1d  — 1 day  before lease_end
//
// Only fires for resources where:
//   - rental_type IN ('long_term', 'flexible')
//   - lease_end IS NOT NULL
//   - lease_tenant_phone IS NOT NULL
//   - lease_end is in the future (within 31 days)
//
// Dedup: lease_renewal_reminders has UNIQUE(resource_id, reminder_type, lease_end_date)
// ---------------------------------------------------------------------------

const LEASE_URGENCY_MAP = {
  renewal_30d: 'gentle',
  renewal_14d: 'gentle',
  renewal_7d:  'urgent',
  renewal_1d:  'final',
};

function getDueLeaseReminderTypes(resource, alreadySent, nowMs) {
  const leaseEndMs = new Date(resource.lease_end).getTime();
  const dayMs      = 24 * 60 * 60 * 1000;
  const msUntil    = leaseEndMs - nowMs;
  const due        = [];

  // Only process leases ending within the next 31 days (or already passed within 1 day)
  if (msUntil > 31 * dayMs || msUntil < -dayMs) return due;

  const key = (type) => `${type}:${resource.lease_end}`;

  if (!alreadySent.has(key('renewal_30d')) && msUntil <= 30 * dayMs && msUntil > 14 * dayMs)
    due.push('renewal_30d');

  if (!alreadySent.has(key('renewal_14d')) && msUntil <= 14 * dayMs && msUntil > 7 * dayMs)
    due.push('renewal_14d');

  if (!alreadySent.has(key('renewal_7d'))  && msUntil <= 7  * dayMs && msUntil > 1 * dayMs)
    due.push('renewal_7d');

  if (!alreadySent.has(key('renewal_1d'))  && msUntil <= 1  * dayMs && msUntil > -dayMs)
    due.push('renewal_1d');

  return due;
}

function buildLeaseRenewalMessage({ tenantName, resourceName, leaseTenantName, leaseEndDate, daysUntilExpiry, urgency }) {
  const dayLabel = daysUntilExpiry <= 1
    ? 'tomorrow'
    : daysUntilExpiry <= 7
    ? `in ${daysUntilExpiry} days`
    : `on ${leaseEndDate}`;

  const greeting = leaseTenantName ? `Hello ${leaseTenantName},` : 'Hello,';

  if (urgency === 'final') {
    return `${greeting}\n\nThis is a reminder that the lease for *${resourceName}* at *${tenantName}* expires ${dayLabel} (${leaseEndDate}).\n\nPlease contact us to arrange renewal or make alternative arrangements.`;
  }
  if (urgency === 'urgent') {
    return `${greeting}\n\nYour lease for *${resourceName}* at *${tenantName}* is expiring ${dayLabel}.\n\nPlease reach out to renew your lease.\n\nLease end date: ${leaseEndDate}`;
  }
  return `${greeting}\n\nThis is a courtesy reminder that the lease for *${resourceName}* at *${tenantName}* will expire on ${leaseEndDate}.\n\nPlease contact us if you would like to renew.`;
}

async function runLeaseRenewalReminders() {
  const nowMs  = Date.now();
  const result = { processed: 0, sent: 0, skipped: 0, errors: 0 };
  const dayMs  = 24 * 60 * 60 * 1000;

  // Fetch resources with active leases expiring within 31 days
  let resources;
  try {
    const { rows } = await db.query(`
      SELECT
        r.id, r.name AS resource_name, r.tenant_id,
        r.lease_end, r.lease_tenant_name, r.lease_tenant_phone,
        t.name AS tenant_name, t.slug AS tenant_slug
      FROM resources r
      JOIN tenants t ON t.id = r.tenant_id
      WHERE r.rental_type IN ('long_term', 'flexible')
        AND r.lease_end IS NOT NULL
        AND r.lease_tenant_phone IS NOT NULL
        AND r.lease_tenant_phone != ''
        AND r.lease_end >= CURRENT_DATE - INTERVAL '1 day'
        AND r.lease_end <= CURRENT_DATE + INTERVAL '31 days'
    `);
    resources = rows;
  } catch (err) {
    // Table may not exist on older DBs — non-fatal
    logger.warn({ err: err.message }, 'LeaseRenewalReminders: could not query resources (migration pending?)');
    return result;
  }

  if (!resources.length) return result;

  // Batch-fetch already-sent reminders
  const resourceIds = resources.map(r => r.id);
  let sentRows = [];
  try {
    const { rows } = await db.query(
      `SELECT resource_id, reminder_type, lease_end_date::text AS lease_end_date
       FROM lease_renewal_reminders WHERE resource_id = ANY($1)`,
      [resourceIds]
    );
    sentRows = rows;
  } catch {
    // Table missing — continue, dedup will fail gracefully below
  }

  // Build map: resourceId → Set of "type:lease_end" keys
  const sentMap = new Map();
  for (const row of sentRows) {
    if (!sentMap.has(row.resource_id)) sentMap.set(row.resource_id, new Set());
    sentMap.get(row.resource_id).add(`${row.reminder_type}:${row.lease_end_date}`);
  }

  for (const resource of resources) {
    result.processed++;
    const alreadySent  = sentMap.get(resource.id) || new Set();
    const dueTypes     = getDueLeaseReminderTypes(resource, alreadySent, nowMs);

    if (!dueTypes.length) { result.skipped++; continue; }

    let creds;
    try { creds = await getWhatsAppCredentials(resource.tenant_id); } catch { creds = null; }

    if (!creds) { result.skipped++; continue; }

    const leaseEndMs    = new Date(resource.lease_end).getTime();
    const daysUntil     = Math.ceil((leaseEndMs - nowMs) / dayMs);

    for (const reminderType of dueTypes) {
      const urgency = LEASE_URGENCY_MAP[reminderType] || 'gentle';
      const message = buildLeaseRenewalMessage({
        tenantName:      resource.tenant_name,
        resourceName:    resource.resource_name,
        leaseTenantName: resource.lease_tenant_name,
        leaseEndDate:    String(resource.lease_end).slice(0, 10),
        daysUntilExpiry: daysUntil,
        urgency,
      });

      try {
        const waResult = await sendMessage({
          to:      resource.lease_tenant_phone,
          message,
          messageType: 'text',
          tenantId: resource.tenant_id,
        });

        try {
          await db.query(
            `INSERT INTO lease_renewal_reminders
               (resource_id, tenant_id, reminder_type, lease_end_date, sent_to, whatsapp_msg_id, ok, error_reason)
             VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8)
             ON CONFLICT (resource_id, reminder_type, lease_end_date) DO NOTHING`,
            [
              resource.id, resource.tenant_id, reminderType,
              String(resource.lease_end).slice(0, 10),
              resource.lease_tenant_phone,
              waResult?.messageId || null,
              waResult?.ok ?? false,
              waResult?.ok ? null : (waResult?.reason || 'unknown'),
            ]
          );
        } catch (_) {}

        if (waResult?.ok) {
          result.sent++;
          logger.info({ resourceId: resource.id, reminderType }, 'LeaseRenewalReminders: sent');
        } else {
          result.errors++;
        }
      } catch (err) {
        result.errors++;
        logger.error({ err, resourceId: resource.id, reminderType }, 'LeaseRenewalReminders: error');
        try {
          await db.query(
            `INSERT INTO lease_renewal_reminders
               (resource_id, tenant_id, reminder_type, lease_end_date, ok, error_reason)
             VALUES ($1,$2,$3,$4::date,false,$5)
             ON CONFLICT (resource_id, reminder_type, lease_end_date) DO NOTHING`,
            [resource.id, resource.tenant_id, reminderType,
             String(resource.lease_end).slice(0, 10), String(err.message || 'error')]
          );
        } catch (_) {}
      }
    }
  }

  logger.info(result, 'LeaseRenewalReminders: run complete');
  return result;
}

module.exports = { runReminderEngine, runLeaseRenewalReminders };
