'use strict';

// routes/tenantWhatsAppSettings.js
// WA-1: Tenant WhatsApp Business Cloud API configuration
//
// Endpoints:
//   GET    /api/tenant/:slug/whatsapp-settings  — get current config status (token never exposed)
//   POST   /api/tenant/:slug/whatsapp-settings  — save credentials (owner or admin)
//   POST   /api/tenant/:slug/whatsapp-settings/test — test credentials before saving
//   DELETE /api/tenant/:slug/whatsapp-settings  — disconnect WhatsApp

const express = require('express');
const router  = express.Router();

const db     = require('../db');
const logger = require('../utils/logger');
const {
  saveWhatsAppCredentials,
  clearWhatsAppCredentials,
  getWhatsAppCredentials,
} = require('../utils/whatsappCredentials');
const { getTenantIdFromSlug } = require('../utils/tenants');
const requireAppAuth           = require('../middleware/requireAppAuth');
const ensureUser               = require('../middleware/ensureUser');
const { requireTenantRole }    = require('../middleware/requireTenantRole');

// ─── Auth helpers (same pattern as tenantPaymentSettings.js) ──────────────────

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

// ─── GET /api/tenant/:slug/whatsapp-settings ─────────────────────────────────
// Returns connection status — never exposes the stored token.

router.get('/:slug/whatsapp-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT whatsapp_phone_number_id,
              whatsapp_active,
              (whatsapp_access_token IS NOT NULL AND whatsapp_access_token <> '') AS has_token
       FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Tenant not found.' });

    // Check if env var fallback is active for this tenant
    const creds = await getWhatsAppCredentials(req.tenantId);
    const usingEnvFallback = !!(creds && creds.source === 'env');

    return res.json({
      connected:        !!(row.has_token && row.whatsapp_active),
      phoneNumberId:    row.whatsapp_phone_number_id || null,
      hasToken:         !!row.has_token,
      active:           row.whatsapp_active,
      usingEnvFallback,
      source:           creds?.source || null,
    });
  } catch (err) {
    logger.error({ err }, 'GET whatsapp-settings error');
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─── POST /api/tenant/:slug/whatsapp-settings/test ───────────────────────────
// Test credentials against Meta API before saving.

router.post('/:slug/whatsapp-settings/test', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { phoneNumberId, accessToken } = req.body || {};
    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ ok: false, message: 'phoneNumberId and accessToken are required.' });
    }

    // Send a test request to Meta — just fetch the phone number info (GET, no message sent)
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      const url  = `https://graph.facebook.com/v19.0/${String(phoneNumberId).trim()}`;
      const opts = {
        hostname: 'graph.facebook.com',
        port: 443,
        path: `/v19.0/${String(phoneNumberId).trim()}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${String(accessToken).trim()}` },
      };
      const reqHttp = https.request(opts, (r) => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => resolve({ statusCode: r.statusCode, body: data }));
      });
      reqHttp.on('error', reject);
      reqHttp.setTimeout(8000, () => { reqHttp.destroy(); reject(new Error('timeout')); });
      reqHttp.end();
    });

    if (result.statusCode === 200) {
      let parsed = {};
      try { parsed = JSON.parse(result.body); } catch { /* ok */ }
      return res.json({
        ok: true,
        message: `Connected — phone number: ${parsed.display_phone_number || parsed.id || phoneNumberId}`,
      });
    }

    let errMsg = `Meta API returned ${result.statusCode}`;
    try {
      const parsed = JSON.parse(result.body);
      if (parsed?.error?.message) errMsg = parsed.error.message;
    } catch { /* ok */ }

    return res.json({ ok: false, message: errMsg });
  } catch (err) {
    logger.error({ err }, 'WhatsApp settings test error');
    return res.json({ ok: false, message: err.message || 'Test failed.' });
  }
});

// ─── POST /api/tenant/:slug/whatsapp-settings ────────────────────────────────
// Save credentials. Optionally tests first.

router.post('/:slug/whatsapp-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { phoneNumberId, accessToken, testFirst = true } = req.body || {};
    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ error: 'phoneNumberId and accessToken are required.' });
    }

    // Optional live test before saving
    if (testFirst) {
      const https = require('https');
      const result = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'graph.facebook.com',
          port: 443,
          path: `/v19.0/${String(phoneNumberId).trim()}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${String(accessToken).trim()}` },
        };
        const reqHttp = https.request(opts, (r) => {
          let data = '';
          r.on('data', c => { data += c; });
          r.on('end', () => resolve({ statusCode: r.statusCode, body: data }));
        });
        reqHttp.on('error', reject);
        reqHttp.setTimeout(8000, () => { reqHttp.destroy(); reject(new Error('timeout')); });
        reqHttp.end();
      });

      if (result.statusCode !== 200) {
        let errMsg = `Meta API returned ${result.statusCode} — check your credentials.`;
        try {
          const parsed = JSON.parse(result.body);
          if (parsed?.error?.message) errMsg = parsed.error.message;
        } catch { /* ok */ }
        return res.status(400).json({ error: errMsg });
      }
    }

    await saveWhatsAppCredentials(req.tenantId, phoneNumberId.trim(), accessToken.trim());

    logger.info({ tenantId: req.tenantId, slug: req.tenantSlug }, 'WhatsApp credentials saved');
    return res.json({ ok: true, message: 'WhatsApp credentials saved and verified.' });
  } catch (err) {
    logger.error({ err }, 'POST whatsapp-settings error');
    return res.status(500).json({ error: 'Failed to save WhatsApp credentials.' });
  }
});

// ─── DELETE /api/tenant/:slug/whatsapp-settings ──────────────────────────────
// Disconnect WhatsApp for a tenant.

router.delete('/:slug/whatsapp-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    await clearWhatsAppCredentials(req.tenantId);
    logger.info({ tenantId: req.tenantId, slug: req.tenantSlug }, 'WhatsApp credentials cleared');
    return res.json({ ok: true, message: 'WhatsApp disconnected.' });
  } catch (err) {
    logger.error({ err }, 'DELETE whatsapp-settings error');
    return res.status(500).json({ error: 'Failed to disconnect WhatsApp.' });
  }
});

module.exports = router;
