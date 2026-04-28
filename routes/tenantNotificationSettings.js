'use strict';

// routes/tenantNotificationSettings.js
// PR D5 (Per-tenant notification toggle matrix).
//
// GET    /api/tenant/:slug/notification-settings  → return all 8 toggles
// PATCH  /api/tenant/:slug/notification-settings  → update any subset of toggles
//
// Auth: owner-only or admin (same pattern as tenantTwilioSettings.js).
// Owner is identified through requireAppAuth + requireTenantRole(['owner']).
//
// The toggles are stored on the tenants table (see migration 052). This route
// is a thin wrapper around utils/notificationGates.js helpers — the gating
// math lives there, the HTTP shape lives here.

const express = require('express');
const router  = express.Router();

const logger = require('../utils/logger');
const {
  getTenantNotificationToggles,
  updateTenantNotificationToggles,
} = require('../utils/notificationGates');
const { getTenantIdFromSlug } = require('../utils/tenants');
const requireAppAuth        = require('../middleware/requireAppAuth');
const ensureUser            = require('../middleware/ensureUser');
const { requireTenantRole } = require('../middleware/requireTenantRole');

// ─── Auth helpers (mirrors tenantTwilioSettings.js) ──────────────────────────

function isAdminRequest(req) {
  const expected = String(process.env.ADMIN_API_KEY || '').trim();
  if (!expected) return false;
  const rawAuth = String(req.headers.authorization || '');
  const bearer  = rawAuth.toLowerCase().startsWith('bearer ') ? rawAuth.slice(7).trim() : '';
  const key = bearer || String(req.headers['x-admin-key'] || '').trim() || String(req.headers['x-api-key'] || '').trim();
  return !!key && key === expected;
}

function requireOwnerOrAdmin(req, res, next) {
  if (isAdminRequest(req)) return next();
  return requireAppAuth(req, res, () =>
    ensureUser(req, res, () =>
      requireTenantRole(['owner'])(req, res, next)
    )
  );
}

async function resolveTenant(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'Missing tenant slug.' });
    req.tenantId   = await getTenantIdFromSlug(slug);
    req.tenantSlug = slug;
    next();
  } catch (err) {
    if (err.code === 'TENANT_NOT_FOUND') return res.status(404).json({ error: 'Tenant not found.' });
    logger.error({ err }, 'resolveTenant error');
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

// ─── GET — return current toggle state ───────────────────────────────────────

router.get('/:slug/notification-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const toggles = await getTenantNotificationToggles(req.tenantId);
    if (!toggles) return res.status(404).json({ error: 'Tenant not found.' });
    return res.json(toggles);
  } catch (err) {
    logger.error({ err: err.message, tenantId: req.tenantId }, 'GET notification-settings failed');
    return res.status(500).json({ error: 'Failed to load notification settings.' });
  }
});

// ─── PATCH — update toggle subset ────────────────────────────────────────────
//
// Body shape (any subset of these is allowed):
//   {
//     sms?:      { confirmations?: bool, reminder_24h?: bool, reminder_1h?: bool, cancellations?: bool },
//     whatsapp?: { confirmations?: bool, reminder_24h?: bool, reminder_1h?: bool, cancellations?: bool }
//   }
// Unspecified keys retain their current value.

router.patch('/:slug/notification-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const patch = req.body || {};
    if (typeof patch !== 'object') {
      return res.status(400).json({ error: 'Invalid body.' });
    }

    // Light validation — reject anything that isn't a plain object on the
    // expected shape so we don't process garbage.
    const okShape =
      (patch.sms == null      || typeof patch.sms === 'object') &&
      (patch.whatsapp == null || typeof patch.whatsapp === 'object');
    if (!okShape) {
      return res.status(400).json({ error: 'sms and whatsapp must be objects.' });
    }

    const next = await updateTenantNotificationToggles(req.tenantId, patch);
    logger.info({ tenantId: req.tenantId, patch }, 'notification settings updated');
    return res.json(next);
  } catch (err) {
    logger.error({ err: err.message, tenantId: req.tenantId }, 'PATCH notification-settings failed');
    return res.status(500).json({ error: 'Failed to update notification settings.' });
  }
});

module.exports = router;
