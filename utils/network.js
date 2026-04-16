'use strict';

// utils/network.js
// PAY-1: Network International / MPGS payment gateway client
//
// All API calls require a tenantId so credentials are loaded per-tenant
// from the DB (with env var fallback for Birdie during initial setup).
//
// MPGS auth: HTTP Basic Auth
//   username = merchant.{merchantId}
//   password = apiPassword

const https = require('https');
const { getNetworkCredentials, isTenantMpgsEnabled } = require('./networkCredentials');
const logger = require('./logger');

// ─── HTTP client ──────────────────────────────────────────────────────────────

function buildAuthHeader(merchantId, apiPassword) {
  const credentials = Buffer.from(`merchant.${merchantId}:${apiPassword}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Sanitize a gateway URL to origin-only so buildApiUrl never doubles the path.
 *
 * Users sometimes paste the full API base (e.g. "https://test-network.../api"
 * or "https://ap-gateway.mastercard.com/api") which would make buildApiUrl
 * produce ".../api/api/rest/..." and return an HTML 404.
 *
 * Strategy: extract only scheme+host+port (URL.origin).
 * If URL parsing fails, strip any trailing /api[/*] manually.
 */
function sanitizeGatewayUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  try {
    return new URL(s).origin; // e.g. "https://test-network.mtf.gateway.mastercard.com"
  } catch {
    // Fallback: strip any /api path suffix
    return s.replace(/\/api(\/.*)?$/, '');
  }
}

function buildApiUrl(gatewayUrl, merchantId, resource) {
  const base = sanitizeGatewayUrl(gatewayUrl);
  return `${base}/api/rest/version/100/merchant/${merchantId}/${resource}`;
}

function mpgsRequest({ method, url, auth, body }) {
  return new Promise((resolve, reject) => {
    const bodyStr   = body ? JSON.stringify(body) : null;
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || 443,
      path:     parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Authorization': auth,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.result === 'ERROR') {
            const err     = new Error(parsed.error?.explanation || 'MPGS API error');
            err.mpgsError = parsed.error;
            err.statusCode = res.statusCode;
            return reject(err);
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`MPGS response parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Per-tenant helpers ───────────────────────────────────────────────────────

/**
 * Load credentials for a tenant or throw a clear error.
 */
async function loadCreds(tenantId) {
  const creds = await getNetworkCredentials(tenantId);
  if (!creds) {
    const err = new Error('Payment gateway not configured for this tenant.');
    err.code  = 'MPGS_NOT_CONFIGURED';
    throw err;
  }
  return creds;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a Hosted Checkout session with MPGS.
 *
 * @param {number} tenantId
 * @param {object} opts
 * @param {string} opts.orderId
 * @param {string} opts.amount          decimal string e.g. "50.000"
 * @param {string} opts.currency        ISO 4217 e.g. "JOD"
 * @param {string} opts.description
 * @param {string} opts.returnUrl
 * @param {string} opts.merchantName    shown on MPGS checkout page
 */
async function createCheckoutSession(tenantId, {
  orderId, amount, currency, description, returnUrl, merchantName,
}) {
  const { merchantId, apiPassword, gatewayUrl } = await loadCreds(tenantId);
  const url  = buildApiUrl(gatewayUrl, merchantId, 'session');
  const auth = buildAuthHeader(merchantId, apiPassword);

  const body = {
    apiOperation: 'INITIATE_CHECKOUT',
    order: {
      id:          'test4',   // PAY-TEST: using short id like provider's test3 to rule out order ID format issues
      amount:      String(amount),
      currency:    currency || 'JOD',
      description: description || 'Flexrz booking',
      reference:   orderId,   // keep our real reference for tracking
    },
    interaction: {
      operation: 'PURCHASE',
      returnUrl,
      merchant: { name: merchantName || 'Flexrz' },
      // PAY-1: tell MPGS to use Hosted Payment Page (not embedded/inline)
      displayControl: { billingAddress: 'HIDE', customerEmail: 'OPTIONAL' },
    },
  };

  logger.info({ tenantId, orderId, amount, currency }, 'MPGS: creating checkout session');
  const response = await mpgsRequest({ method: 'POST', url, auth, body });

  if (!response.session?.id) {
    throw new Error('MPGS session creation returned no sessionId');
  }

  return {
    sessionId:        response.session.id,
    successIndicator: response.successIndicator,
    merchantId,
    gatewayUrl,
  };
}

/**
 * Retrieve the full order from MPGS (verify payment server-side after redirect).
 */
async function retrieveOrder(tenantId, orderId) {
  const { merchantId, apiPassword, gatewayUrl } = await loadCreds(tenantId);
  const url  = buildApiUrl(gatewayUrl, merchantId, `order/${encodeURIComponent(orderId)}`);
  const auth = buildAuthHeader(merchantId, apiPassword);

  logger.info({ tenantId, orderId }, 'MPGS: retrieving order');
  return mpgsRequest({ method: 'GET', url, auth });
}

/**
 * Issue a refund against a captured transaction.
 */
async function refundTransaction(tenantId, orderId, transactionId, refundTransactionId, amount, currency) {
  const { merchantId, apiPassword, gatewayUrl } = await loadCreds(tenantId);
  const resource = `order/${encodeURIComponent(orderId)}/transaction/${encodeURIComponent(refundTransactionId)}`;
  const url  = buildApiUrl(gatewayUrl, merchantId, resource);
  const auth = buildAuthHeader(merchantId, apiPassword);

  const body = {
    apiOperation: 'REFUND',
    transaction:  { amount: String(amount), currency },
    order:        { id: orderId },
  };

  logger.info({ tenantId, orderId, amount }, 'MPGS: issuing refund');
  return mpgsRequest({ method: 'PUT', url, auth, body });
}

/**
 * Test that a set of credentials works by calling MPGS with a minimal session.
 * Used by the setup screen to verify before saving.
 *
 * @param {string} merchantId
 * @param {string} apiPassword
 * @param {string} gatewayUrl
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function testCredentials(merchantId, apiPassword, gatewayUrl) {
  const DEFAULT_GW = 'https://test-network.mtf.gateway.mastercard.com';
  // sanitizeGatewayUrl strips any /api path the user accidentally included.
  const gw   = sanitizeGatewayUrl(gatewayUrl || DEFAULT_GW);
  const url  = buildApiUrl(gw, merchantId, 'session');
  const auth = buildAuthHeader(merchantId, apiPassword);

  const body = {
    apiOperation: 'INITIATE_CHECKOUT',
    order: {
      id:       `TEST-VERIFY-${Date.now()}`,
      amount:   '0.01',
      currency: 'JOD',
    },
    interaction: {
      operation: 'PURCHASE',
      returnUrl: 'https://flexrz.com/payment/test-return',
    },
  };

  try {
    const response = await mpgsRequest({ method: 'POST', url, auth, body });
    return { ok: response.result !== 'ERROR' };
  } catch (err) {
    return { ok: false, error: err.mpgsError?.explanation || err.message };
  }
}

module.exports = {
  sanitizeGatewayUrl,   // exported so networkPayments.js can build a clean checkoutJsUrl
  isTenantMpgsEnabled,
  createCheckoutSession,
  retrieveOrder,
  refundTransaction,
  testCredentials,
};
