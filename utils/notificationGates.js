'use strict';

// utils/notificationGates.js
// PR D5 (Per-tenant notification toggle matrix).
//
// Single source of truth for "should this notification fire?" decisions.
// Every send site (smsReminderEngine, whatsappReminderEngine, bookings/create
// SMS confirmation, bookings/create WA confirmation, bookings/crud SMS
// cancellation) calls into here so the gating logic is consistent and
// auditable in one place.
//
// Each notification fire is gated by the AND of three conditions:
//
//   1. PLAN — the tenant's SaaS plan includes the relevant feature
//             ('sms_notifications' or 'whatsapp_notifications'). Resolved
//             through utils/entitlements.js → hasFeature().
//
//   2. CREDENTIALS — the tenant has Twilio (or Meta WhatsApp) credentials
//             configured AND active. Resolved through
//             utils/twilioCredentials.js → isTwilioEnabledForTenant() and
//             utils/whatsappCredentials.js → isWhatsAppEnabledForTenant().
//
//   3. EVENT TOGGLE — the per-tenant per-event toggle is TRUE in the
//             tenants table (migration 052). Lets a tenant who has the plan
//             AND the credentials still suppress, e.g., 24h reminders or
//             cancellation SMS specifically.
//
// All three must be TRUE for the notification to fire. Any FALSE skips it.
//
// Failure modes — every step in the AND fails closed:
//   - Plan lookup fails → treated as no plan → don't send.
//   - Credentials lookup fails → treated as no creds → don't send.
//   - Toggle column missing or NULL → treated as TRUE (DEFAULT TRUE).
//   - Toggle column lookup fails → fail closed (don't send).
//
// The toggle column lookup is intentionally generous: NULL or missing column
// is treated as "enabled" so a half-applied migration doesn't silently kill
// notifications. The other two gates are strict.

const db = require('../db');
const logger = require('./logger');
const { hasFeature } = require('./entitlements');
const { isTwilioEnabledForTenant } = require('./twilioCredentials');
const { isWhatsAppEnabledForTenant } = require('./whatsappCredentials');

// ─── Event-to-column map ────────────────────────────────────────────────────

const SMS_TOGGLE_COLUMNS = Object.freeze({
  confirmations: 'sms_confirmations_enabled',
  reminder_24h:  'sms_reminder_24h_enabled',
  reminder_1h:   'sms_reminder_1h_enabled',
  cancellations: 'sms_cancellations_enabled',
});

const WA_TOGGLE_COLUMNS = Object.freeze({
  confirmations: 'wa_confirmations_enabled',
  reminder_24h:  'wa_reminder_24h_enabled',
  reminder_1h:   'wa_reminder_1h_enabled',
  cancellations: 'wa_cancellations_enabled',
});

const VALID_EVENT_KINDS = Object.freeze(['confirmations', 'reminder_24h', 'reminder_1h', 'cancellations']);

// ─── Toggle reader ──────────────────────────────────────────────────────────

/**
 * Read a single toggle column for one tenant. NULL or column-missing = TRUE
 * (defaults to enabled). Other DB errors fail closed.
 */
async function readToggle(tenantId, column) {
  try {
    const { rows } = await db.query(
      `SELECT ${column} AS toggle FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    if (rows.length === 0) return false; // tenant not found — fail closed
    const v = rows[0].toggle;
    if (v === null || v === undefined) return true; // generous default
    return Boolean(v);
  } catch (err) {
    // Column may not exist if migration 052 hasn't run yet. Fail closed by
    // default, but log the discrepancy at WARN so it gets noticed.
    if (/column .* does not exist/i.test(err.message || '')) {
      logger.warn(
        { column, tenantId, msg: 'notification toggle column missing — migration 052 not applied yet, defaulting to enabled' },
      );
      return true; // pre-052 schema = legacy behavior = always enabled
    }
    logger.error({ err: err.message, column, tenantId }, 'readToggle failed; defaulting to NOT sending');
    return false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Should an SMS fire for this tenant + event?
 *
 * @param {number|string} tenantId  — the booking's tenant_id
 * @param {string} eventKind        — one of: confirmations, reminder_24h, reminder_1h, cancellations
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 *   ok=true  → all 3 gates pass; the caller should send.
 *   ok=false → at least one gate failed; reason explains which.
 */
async function shouldSendSMS(tenantId, eventKind) {
  if (!VALID_EVENT_KINDS.includes(eventKind)) {
    return { ok: false, reason: `invalid eventKind "${eventKind}"` };
  }

  // Gate 1 — plan
  const planEnabled = await hasFeature(tenantId, 'sms_notifications').catch(() => false);
  if (!planEnabled) return { ok: false, reason: 'plan_disabled' };

  // Gate 2 — credentials
  const credsEnabled = await isTwilioEnabledForTenant(tenantId).catch(() => false);
  if (!credsEnabled) return { ok: false, reason: 'creds_missing' };

  // Gate 3 — per-event toggle
  const column = SMS_TOGGLE_COLUMNS[eventKind];
  const toggleOn = await readToggle(tenantId, column);
  if (!toggleOn) return { ok: false, reason: 'tenant_toggle_off' };

  return { ok: true };
}

/**
 * Should a WhatsApp message fire for this tenant + event? Same shape as
 * shouldSendSMS but uses 'whatsapp_notifications' feature key, the
 * WhatsApp credential check, and the wa_*_enabled columns.
 */
async function shouldSendWA(tenantId, eventKind) {
  if (!VALID_EVENT_KINDS.includes(eventKind)) {
    return { ok: false, reason: `invalid eventKind "${eventKind}"` };
  }

  const planEnabled = await hasFeature(tenantId, 'whatsapp_notifications').catch(() => false);
  if (!planEnabled) return { ok: false, reason: 'plan_disabled' };

  const credsEnabled = await isWhatsAppEnabledForTenant(tenantId).catch(() => false);
  if (!credsEnabled) return { ok: false, reason: 'creds_missing' };

  const column = WA_TOGGLE_COLUMNS[eventKind];
  const toggleOn = await readToggle(tenantId, column);
  if (!toggleOn) return { ok: false, reason: 'tenant_toggle_off' };

  return { ok: true };
}

/**
 * Read all 8 toggles for a tenant in one query — used by the GET endpoint
 * that powers the frontend matrix. Returns sane defaults if columns are
 * missing (migration not applied) so the UI still renders.
 */
async function getTenantNotificationToggles(tenantId) {
  const allColumns = [
    ...Object.values(SMS_TOGGLE_COLUMNS),
    ...Object.values(WA_TOGGLE_COLUMNS),
  ];
  try {
    const { rows } = await db.query(
      `SELECT ${allColumns.join(', ')} FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      sms: {
        confirmations: row.sms_confirmations_enabled !== false,
        reminder_24h:  row.sms_reminder_24h_enabled  !== false,
        reminder_1h:   row.sms_reminder_1h_enabled   !== false,
        cancellations: row.sms_cancellations_enabled !== false,
      },
      whatsapp: {
        confirmations: row.wa_confirmations_enabled !== false,
        reminder_24h:  row.wa_reminder_24h_enabled  !== false,
        reminder_1h:   row.wa_reminder_1h_enabled   !== false,
        cancellations: row.wa_cancellations_enabled !== false,
      },
    };
  } catch (err) {
    if (/column .* does not exist/i.test(err.message || '')) {
      // Pre-052 schema — return legacy "all enabled" defaults so the UI
      // doesn't break before the migration is run.
      logger.warn({ tenantId }, 'notification toggle columns missing — returning legacy defaults');
      return {
        sms:      { confirmations: true, reminder_24h: true, reminder_1h: true, cancellations: true },
        whatsapp: { confirmations: true, reminder_24h: true, reminder_1h: true, cancellations: true },
      };
    }
    throw err;
  }
}

/**
 * Update a subset of toggles for a tenant. The patch payload may set any
 * combination of sms.* and whatsapp.* booleans; unspecified keys retain
 * their current value.
 *
 * Returns the new full toggle state (same shape as getTenantNotificationToggles).
 */
async function updateTenantNotificationToggles(tenantId, patch) {
  const updates = [];
  const params = [tenantId];

  const consider = (path, columnMap) => {
    if (!path || typeof path !== 'object') return;
    for (const [eventKind, value] of Object.entries(path)) {
      if (typeof value !== 'boolean') continue;
      const column = columnMap[eventKind];
      if (!column) continue;
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    }
  };

  consider(patch?.sms,      SMS_TOGGLE_COLUMNS);
  consider(patch?.whatsapp, WA_TOGGLE_COLUMNS);

  if (updates.length === 0) {
    // Nothing to update — just return the current state.
    return getTenantNotificationToggles(tenantId);
  }

  await db.query(
    `UPDATE tenants SET ${updates.join(', ')} WHERE id = $1`,
    params
  );
  return getTenantNotificationToggles(tenantId);
}

module.exports = {
  shouldSendSMS,
  shouldSendWA,
  getTenantNotificationToggles,
  updateTenantNotificationToggles,
  VALID_EVENT_KINDS,
};
