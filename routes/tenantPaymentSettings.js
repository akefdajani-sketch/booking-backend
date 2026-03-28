'use strict';

// routes/tenantPaymentSettings.js
// PAY-1: Tenant payment gateway configuration
//
// Endpoints:
//   GET  /api/tenant/:slug/payment-settings   — get current config status (no password exposed)
//   POST /api/tenant/:slug/payment-settings   — save credentials (owner or admin)
//   POST /api/tenant/:slug/payment-settings/test — test credentials before saving
//   POST /api/tenant/:slug/payment-settings/verify — verify credentials already in DB
//   DELETE /api/tenant/:slug/payment-settings — disconnect payment gateway
//
// Auth:
//   - Owner role via Google auth (self-serve)
//   - OR platform ADMIN_API_KEY (admin override — used by Flexrz dashboard)

const express = require('express');
const router  = express.Router();

const db     = require('../db');
const logger = require('../utils/logger');
const {
  saveNetworkCredentials,
  clearNetworkCredentials,
  getNetworkCredentials,
} = require('../utils/networkCredentials');
const { testCredentials }   = require('../utils/network');
const { getTenantIdFromSlug } = require('../utils/tenants');
const requireGoogleAuth     = require('../middleware/requireGoogleAuth');
const ensureUser            = require('../middleware/ensureUser');
const { requireTenantRole } = require('../middleware/requireTenantRole');

// ─── Auth helpers (same pattern as tenantMembershipCheckout.js) ───────────────

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
  return requireGoogleAuth(req, res, () =>
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

// ─── GET /api/tenant/:slug/payment-settings ───────────────────────────────────
// Returns connection status — never exposes the stored password.

router.get('/:slug/payment-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT network_merchant_id,
              network_gateway_url,
              payment_gateway_active,
              (network_api_password IS NOT NULL AND network_api_password <> '') AS has_password
       FROM tenants WHERE id = $1`,
      [req.tenantId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Tenant not found.' });
    const row = rows[0];

    // Check env var fallback for Birdie / early tenants
    const envMerchantId = String(process.env.NETWORK_MERCHANT_ID || '').trim();
    const usingEnvFallback = !row.network_merchant_id && !row.has_password && Boolean(envMerchantId);

    return res.json({
      connected:           row.payment_gateway_active || usingEnvFallback,
      merchantId:          row.network_merchant_id || (usingEnvFallback ? envMerchantId : null),
      gatewayUrl:          row.network_gateway_url || process.env.NETWORK_GATEWAY_URL || 'https://test-network.mtf.gateway.mastercard.com',
      hasPassword:         row.has_password || usingEnvFallback,
      usingEnvFallback,
      source:              row.network_merchant_id ? 'database' : (usingEnvFallback ? 'env_fallback' : 'none'),
    });
  } catch (err) {
    logger.error({ err }, 'GET payment-settings error');
    return res.status(500).json({ error: 'Failed to load payment settings.' });
  }
});

// ─── POST /api/tenant/:slug/payment-settings/test ────────────────────────────
// Test credentials WITHOUT saving. Safe to call before committing.
// Body: { merchantId, apiPassword, gatewayUrl? }

router.post('/:slug/payment-settings/test', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const merchantId  = String(req.body?.merchantId  || '').trim();
    const apiPassword = String(req.body?.apiPassword || '').trim();
    const gatewayUrl  = String(req.body?.gatewayUrl  || '').trim();

    if (!merchantId)  return res.status(400).json({ error: 'merchantId is required.' });
    if (!apiPassword) return res.status(400).json({ error: 'apiPassword is required.' });

    const result = await testCredentials(merchantId, apiPassword, gatewayUrl || null);

    logger.info({ tenantId: req.tenantId, merchantId, ok: result.ok }, 'Payment credential test');

    return res.json({
      ok:      result.ok,
      message: result.ok ? 'Credentials verified successfully.' : (result.error || 'Credentials test failed.'),
    });
  } catch (err) {
    logger.error({ err }, 'POST payment-settings/test error');
    return res.status(500).json({ error: 'Failed to test credentials.' });
  }
});

// ─── POST /api/tenant/:slug/payment-settings ─────────────────────────────────
// Save credentials to DB (encrypted). Optionally test first.
// Body: { merchantId, apiPassword, gatewayUrl?, testFirst? }

router.post('/:slug/payment-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const merchantId  = String(req.body?.merchantId  || '').trim();
    const apiPassword = String(req.body?.apiPassword || '').trim();
    const gatewayUrl  = String(req.body?.gatewayUrl  || '').trim();
    const testFirst   = req.body?.testFirst !== false; // default true

    if (!merchantId)  return res.status(400).json({ error: 'merchantId is required.' });
    if (!apiPassword) return res.status(400).json({ error: 'apiPassword is required.' });

    // Always test before saving unless explicitly skipped
    if (testFirst) {
      const test = await testCredentials(merchantId, apiPassword, gatewayUrl || null);
      if (!test.ok) {
        return res.status(422).json({
          error:   'Credentials verification failed — not saved.',
          details: test.error || 'MPGS rejected the credentials.',
        });
      }
    }

    await saveNetworkCredentials(
      req.tenantId,
      merchantId,
      apiPassword,
      gatewayUrl || null
    );

    logger.info({ tenantId: req.tenantId, merchantId }, 'Tenant payment credentials saved');

    return res.json({
      ok:        true,
      message:   'Payment gateway connected successfully.',
      merchantId,
      gatewayUrl: gatewayUrl || 'https://test-network.mtf.gateway.mastercard.com',
    });
  } catch (err) {
    logger.error({ err }, 'POST payment-settings error');
    if (err.message?.includes('TENANT_CREDS_KEY')) {
      return res.status(500).json({ error: 'Server encryption key not configured. Contact platform admin.' });
    }
    return res.status(500).json({ error: 'Failed to save payment settings.' });
  }
});

// ─── DELETE /api/tenant/:slug/payment-settings ───────────────────────────────
// Disconnect payment gateway — clears credentials from DB.

router.delete('/:slug/payment-settings', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    await clearNetworkCredentials(req.tenantId);
    logger.info({ tenantId: req.tenantId }, 'Tenant payment credentials cleared');
    return res.json({ ok: true, message: 'Payment gateway disconnected.' });
  } catch (err) {
    logger.error({ err }, 'DELETE payment-settings error');
    return res.status(500).json({ error: 'Failed to disconnect payment gateway.' });
  }
});

module.exports = router;

// ─── GET /api/tenant/:slug/payment-methods ────────────────────────────────────
// Returns which payment methods the tenant allows.
// Public — called by booking frontend to know what to offer customers.

router.get('/:slug/payment-methods', resolveTenant, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT branding FROM tenants WHERE id = $1 LIMIT 1`,
      [req.tenantId]
    );
    const branding = rows[0]?.branding || {};
    const settings = branding?.paymentSettings || {};

    // Defaults: card and Cliq on, cash off
    return res.json({
      allow_card:  settings.allow_card  !== false,
      allow_cliq:  settings.allow_cliq  !== false,
      allow_cash:  settings.allow_cash  === true,
    });
  } catch (err) {
    logger.error({ err }, 'GET payment-methods error');
    return res.status(500).json({ error: 'Failed to load payment methods.' });
  }
});

// ─── PUT /api/tenant/:slug/payment-methods ────────────────────────────────────
// Owner: update which payment methods are allowed.
// Body: { allow_card?, allow_cliq?, allow_cash? }

router.put('/:slug/payment-methods', resolveTenant, requireOwnerOrAdmin, async (req, res) => {
  try {
    const settings = {
      allow_card:  req.body?.allow_card  !== false,
      allow_cliq:  req.body?.allow_cliq  !== false,
      allow_cash:  req.body?.allow_cash  === true,
    };

    await db.query(
      `UPDATE tenants
       SET branding = COALESCE(branding, '{}'::jsonb) ||
                      jsonb_build_object('paymentSettings', $1::jsonb)
       WHERE id = $2`,
      [JSON.stringify(settings), req.tenantId]
    );

    logger.info({ tenantId: req.tenantId, settings }, 'Payment methods updated');
    return res.json({ ok: true, ...settings });
  } catch (err) {
    logger.error({ err }, 'PUT payment-methods error');
    return res.status(500).json({ error: 'Failed to update payment methods.' });
  }
});

