'use strict';

// routes/tenantTwilioSettings.js
// PR 145: Tenant Twilio Programmable Messaging configuration
//
// Mirrors tenantWhatsAppSettings.js (WA-1) — same auth helpers, same shape,
// same fallback logic. Key differences:
//   - Twilio fields: accountSid + authToken + fromNumber + optional messagingServiceSid
//   - Test endpoint calls api.twilio.com /2010-04-01/Accounts/:sid (GET) to validate
//   - DB columns in migration 036_tenant_twilio_credentials.sql
//
// Endpoints:
//   GET    /api/tenant/:slug/twilio-settings       — get config status (token never exposed)
//   POST   /api/tenant/:slug/twilio-settings       — save credentials (owner or admin)
//   POST   /api/tenant/:slug/twilio-settings/test  — test credentials before saving
//   DELETE /api/tenant/:slug/twilio-settings       — disconnect Twilio

const express = require('express');
const router  = express.Router();

const db     = require('../db');
const logger = require('../utils/logger');
const {
  saveTwilioCredentials,
  clearTwilioCredentials,
  getTwilioCredentials,
} = require('../utils/twilioCredentials');
const { getTenantIdFromSlug } = require('../utils/tenants');
const requireAppAuth           = require('../middleware/requireAppAuth');
const ensureUser               = require('../middleware/ensureUser');
const { requireTenantRole }    = require('../middleware/requireTenantRole');

// ─── Auth helpers (same pattern as tenantWhatsAppSettings.js) ─────────────────

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

// ─── Middleware: resolve tenantId from :slug ──────────────────────────────────

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

// ─── Helper: test Twilio credentials via GET /2010-04-01/Accounts/:sid ────────
// Returns { ok, statusCode, body, error }. Uses the same timeout pattern as
// the WhatsApp test. Twilio API uses HTTP Basic with accountSid + authToken.

function testTwilioCredentials({ accountSid, authToken }) {
  return new Promise((resolve) => {
    const sid = String(accountSid || '').trim();
    const tok = String(authToken  || '').trim();
    if (!sid || !tok) return resolve({ ok: false, statusCode: 0, error: 'Missing SID or token.' });

    const https = require('https');
    const auth  = Buffer.from(`${sid}:${tok}`).toString('base64');
    const opts  = {
      hostname: 'api.twilio.com',
      port: 443,
      path: `/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`,
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
    };

    const reqHttp = https.request(opts, (r) => {
      let data = '';
      r.on('data', (c) => { data += c; });
      r.on('end', () => resolve({ ok: r.statusCode === 200, statusCode: r.statusCode, body: data }));
    });
    reqHttp.on('error', (e) => resolve({ ok: false, statusCode: 0, error: e.message || 'Network error.' }));
    reqHttp.setTimeout(8000, () => { reqHttp.destroy(); resolve({ ok: false, statusCode: 0, error: 'timeout' }); });
    reqHttp.end();
  });
}

// ─── GET /api/tenant/:slug/twilio-settings ───────────────────────────────────
// Returns connection status — never exposes the stored token.

router.get('/:slug/twilio-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT twilio_account_sid,
              twilio_from_number,
              twilio_messaging_service_sid,
              twilio_active,
              (twilio_auth_token IS NOT NULL AND twilio_auth_token <> '') AS has_token
       FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Tenant not found.' });

    // Check if env var fallback is active for this tenant
    const creds = await getTwilioCredentials(req.tenantId);
    const usingEnvFallback = !!(creds && creds.source === 'env');

    return res.json({
      connected:            !!(row.has_token && row.twilio_active),
      accountSid:           row.twilio_account_sid || null,
      fromNumber:           row.twilio_from_number || null,
      messagingServiceSid:  row.twilio_messaging_service_sid || null,
      hasAuthToken:         !!row.has_token,
      active:               row.twilio_active,
      usingEnvFallback,
      source:               creds?.source || null,
    });
  } catch (err) {
    logger.error({ err }, 'GET twilio-settings error');
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─── POST /api/tenant/:slug/twilio-settings/test ─────────────────────────────
// Test credentials against Twilio before saving.

router.post('/:slug/twilio-settings/test', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { accountSid, authToken } = req.body || {};
    if (!accountSid || !authToken) {
      return res.status(400).json({ ok: false, message: 'accountSid and authToken are required.' });
    }

    const result = await testTwilioCredentials({ accountSid, authToken });

    if (result.ok) {
      let friendlyName = accountSid;
      try {
        const parsed = JSON.parse(result.body || '{}');
        if (parsed?.friendly_name) friendlyName = parsed.friendly_name;
      } catch { /* ok */ }
      return res.json({ ok: true, message: `Connected — account: ${friendlyName}` });
    }

    let errMsg = result.error || `Twilio API returned ${result.statusCode}`;
    try {
      const parsed = JSON.parse(result.body || '{}');
      if (parsed?.message) errMsg = parsed.message;
    } catch { /* ok */ }

    return res.json({ ok: false, message: errMsg });
  } catch (err) {
    logger.error({ err }, 'Twilio settings test error');
    return res.json({ ok: false, message: err.message || 'Test failed.' });
  }
});

// ─── POST /api/tenant/:slug/twilio-settings ──────────────────────────────────
// Save credentials. Optionally tests first.

router.post('/:slug/twilio-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { accountSid, authToken, fromNumber, messagingServiceSid, testFirst = true } = req.body || {};
    if (!accountSid || !authToken || !fromNumber) {
      return res.status(400).json({ error: 'accountSid, authToken, and fromNumber are required.' });
    }

    // Optional live test before saving
    if (testFirst) {
      const result = await testTwilioCredentials({ accountSid, authToken });
      if (!result.ok) {
        let errMsg = result.error || `Twilio API returned ${result.statusCode} — check your credentials.`;
        try {
          const parsed = JSON.parse(result.body || '{}');
          if (parsed?.message) errMsg = parsed.message;
        } catch { /* ok */ }
        return res.status(400).json({ error: errMsg });
      }
    }

    await saveTwilioCredentials(req.tenantId, {
      accountSid:           String(accountSid).trim(),
      authToken:            String(authToken).trim(),
      fromNumber:           String(fromNumber).trim(),
      messagingServiceSid:  messagingServiceSid ? String(messagingServiceSid).trim() : null,
    });

    logger.info({ tenantId: req.tenantId, slug: req.tenantSlug }, 'Twilio credentials saved');
    return res.json({ ok: true, message: 'Twilio credentials saved and verified.' });
  } catch (err) {
    logger.error({ err }, 'POST twilio-settings error');
    return res.status(500).json({ error: 'Failed to save Twilio credentials.' });
  }
});

// ─── DELETE /api/tenant/:slug/twilio-settings ────────────────────────────────
// Disconnect Twilio for a tenant.

router.delete('/:slug/twilio-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    await clearTwilioCredentials(req.tenantId);
    logger.info({ tenantId: req.tenantId, slug: req.tenantSlug }, 'Twilio credentials cleared');
    return res.json({ ok: true, message: 'Twilio disconnected.' });
  } catch (err) {
    logger.error({ err }, 'DELETE twilio-settings error');
    return res.status(500).json({ error: 'Failed to disconnect Twilio.' });
  }
});

module.exports = router;
