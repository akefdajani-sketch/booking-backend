'use strict';

// utils/networkCredentials.js
// PAY-1: Resolve Network International credentials for a given tenant.
//
// Priority order:
//   1. Tenant DB record (network_merchant_id + decrypted network_api_password)
//   2. Env var fallback (NETWORK_MERCHANT_ID + NETWORK_API_PASSWORD)
//
// The fallback covers Birdie Golf and any early tenant while the setup UI
// is being built. Once a tenant saves credentials via the setup screen,
// the DB record takes over automatically.
//
// Encryption:
//   Passwords are stored AES-256-GCM encrypted. Set TENANT_CREDS_KEY to a
//   64-char hex string (32 bytes). Generate: openssl rand -hex 32
//   If the key is absent, encrypted values cannot be decrypted and the
//   resolver returns null for that tenant (falls back to env vars).
//
// Usage:
//   const { getNetworkCredentials, isTenantMpgsEnabled } = require('./networkCredentials');
//   const creds = await getNetworkCredentials(tenantId);
//   if (!creds) return res.status(503).json({ error: 'Payment not configured.' });

const crypto = require('crypto');
const db     = require('../db');
const logger = require('./logger');

const ALGO        = 'aes-256-gcm';
const DEFAULT_GW  = 'https://test-network.mtf.gateway.mastercard.com';

// ─── Encryption helpers ───────────────────────────────────────────────────────

function getEncKey() {
  const hex = String(process.env.TENANT_CREDS_KEY || '').trim();
  if (hex.length !== 64) return null;
  try { return Buffer.from(hex, 'hex'); } catch { return null; }
}

/**
 * Encrypt a plaintext string. Returns a base64 string: iv:authTag:ciphertext
 */
function encryptPassword(plaintext) {
  const key = getEncKey();
  if (!key) throw new Error('TENANT_CREDS_KEY not set or invalid (need 64 hex chars). Run: openssl rand -hex 32');

  const iv      = crypto.randomBytes(12);
  const cipher  = crypto.createCipheriv(ALGO, key, iv);
  const enc     = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag     = cipher.getAuthTag();

  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/**
 * Decrypt a stored base64 string. Returns plaintext or null on failure.
 */
function decryptPassword(stored) {
  if (!stored) return null;
  const key = getEncKey();
  if (!key) {
    logger.warn('TENANT_CREDS_KEY missing — cannot decrypt tenant payment credentials');
    return null;
  }

  try {
    const parts = String(stored).split(':');
    if (parts.length !== 3) return null;

    const iv         = Buffer.from(parts[0], 'base64');
    const authTag    = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch (err) {
    logger.error({ err }, 'Failed to decrypt tenant payment credentials');
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve Network International credentials for a tenant.
 *
 * @param {number|string} tenantId
 * @returns {Promise<{ merchantId: string, apiPassword: string, gatewayUrl: string } | null>}
 *   Returns null if no credentials are available from either DB or env vars.
 */
async function getNetworkCredentials(tenantId) {
  // ── Step 1: Try DB record ──────────────────────────────────────────────────
  if (tenantId) {
    try {
      const { rows } = await db.query(
        `SELECT network_merchant_id, network_api_password, network_gateway_url
         FROM tenants WHERE id = $1 LIMIT 1`,
        [Number(tenantId)]
      );
      const row = rows[0];

      if (row?.network_merchant_id && row?.network_api_password) {
        const decrypted = decryptPassword(row.network_api_password);
        if (decrypted) {
          return {
            merchantId:  row.network_merchant_id.trim(),
            apiPassword: decrypted,
            gatewayUrl:  (row.network_gateway_url || DEFAULT_GW).trim().replace(/\/$/, ''),
          };
        }
        logger.warn({ tenantId }, 'Tenant has payment credentials but decryption failed — falling back to env vars');
      }
    } catch (err) {
      logger.error({ err, tenantId }, 'Failed to read tenant payment credentials from DB — falling back to env vars');
    }
  }

  // ── Step 2: Env var fallback (covers Birdie while setup UI is built) ───────
  const merchantId  = String(process.env.NETWORK_MERCHANT_ID  || '').trim();
  const apiPassword = String(process.env.NETWORK_API_PASSWORD || '').trim();
  const gatewayUrl  = String(process.env.NETWORK_GATEWAY_URL  || DEFAULT_GW).trim().replace(/\/$/, '');

  if (merchantId && apiPassword) {
    return { merchantId, apiPassword, gatewayUrl };
  }

  return null;
}

/**
 * Returns true if the given tenant has usable payment credentials
 * (either from DB or env var fallback).
 *
 * @param {number|string} tenantId
 */
async function isTenantMpgsEnabled(tenantId) {
  const creds = await getNetworkCredentials(tenantId);
  return Boolean(creds);
}

/**
 * Save (or update) encrypted Network credentials for a tenant.
 * Used by the setup API — both owner self-serve and admin override.
 *
 * @param {number} tenantId
 * @param {string} merchantId
 * @param {string} apiPassword  plain text — will be encrypted before storage
 * @param {string} [gatewayUrl]
 */
async function saveNetworkCredentials(tenantId, merchantId, apiPassword, gatewayUrl) {
  const encrypted = encryptPassword(apiPassword);

  await db.query(
    `UPDATE tenants
     SET network_merchant_id    = $1,
         network_api_password   = $2,
         network_gateway_url    = $3,
         payment_gateway_active = true,
         updated_at             = NOW()
     WHERE id = $4`,
    [
      String(merchantId).trim(),
      encrypted,
      (gatewayUrl || DEFAULT_GW).trim().replace(/\/$/, ''),
      Number(tenantId),
    ]
  );
}

/**
 * Clear payment credentials for a tenant.
 * Disables their payment integration without deleting the tenant.
 */
async function clearNetworkCredentials(tenantId) {
  await db.query(
    `UPDATE tenants
     SET network_merchant_id    = NULL,
         network_api_password   = NULL,
         network_gateway_url    = NULL,
         payment_gateway_active = false,
         updated_at             = NOW()
     WHERE id = $1`,
    [Number(tenantId)]
  );
}

module.exports = {
  getNetworkCredentials,
  isTenantMpgsEnabled,
  saveNetworkCredentials,
  clearNetworkCredentials,
  encryptPassword,  // exported for tests
  decryptPassword,  // exported for tests
};
