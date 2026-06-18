'use strict';

// utils/bankEtihadCredentials.js
// PAY-BAE: Bank al Etihad (Cybersource) tenant credential storage.
//
// Mirrors utils/networkCredentials.js for the MPGS gateway. Reuses the same
// AES-256-GCM helpers (encryptPassword / decryptPassword) — no new crypto.
//
// Columns (added by migration 076):
//   bank_etihad_merchant_id   TEXT  — plaintext
//   bank_etihad_api_secret    TEXT  — encrypted (iv:tag:ct base64)
//   bank_etihad_cc_token      TEXT  — encrypted (iv:tag:ct base64)
//   bank_etihad_host          TEXT  — plaintext (Cybersource host, e.g. api.cybersource.com)
//   payment_provider          TEXT  — 'bank_etihad' when this gateway is selected
//
// Encryption requires TENANT_CREDS_KEY (64 hex chars, 32 bytes). If absent,
// decryption fails closed and getBankEtihadCredentials returns null.

const db = require('../db');
const logger = require('./logger');
const { encryptPassword, decryptPassword } = require('./networkCredentials');

const DEFAULT_HOST = 'api.cybersource.com';

/**
 * Save (or update) encrypted Bank al Etihad credentials for a tenant.
 * Sets payment_provider='bank_etihad' to mark this gateway as the active one.
 *
 * @param {number|string} tenantId
 * @param {{ merchantId: string, apiSecret: string, ccToken: string, host?: string }} creds
 */
async function saveBankEtihadCredentials(tenantId, { merchantId, apiSecret, ccToken, host } = {}) {
  const encSecret = encryptPassword(apiSecret);
  const encToken  = encryptPassword(ccToken);
  const hostValue = String(host || DEFAULT_HOST).trim() || DEFAULT_HOST;

  await db.query(
    `UPDATE tenants
     SET bank_etihad_merchant_id = $1,
         bank_etihad_api_secret  = $2,
         bank_etihad_cc_token    = $3,
         bank_etihad_host        = $4,
         payment_provider        = 'bank_etihad'
     WHERE id = $5`,
    [
      String(merchantId).trim(),
      encSecret,
      encToken,
      hostValue,
      Number(tenantId),
    ]
  );
}

/**
 * Resolve Bank al Etihad credentials for a tenant.
 *
 * @param {number|string} tenantId
 * @returns {Promise<{ merchantId: string, apiSecret: string, ccToken: string, host: string } | null>}
 *   Returns null if merchantId/api_secret absent or decryption fails.
 */
async function getBankEtihadCredentials(tenantId) {
  if (!tenantId) return null;

  try {
    const { rows } = await db.query(
      `SELECT bank_etihad_merchant_id,
              bank_etihad_api_secret,
              bank_etihad_cc_token,
              bank_etihad_host
       FROM tenants WHERE id = $1 LIMIT 1`,
      [Number(tenantId)]
    );
    const row = rows[0];

    if (!row?.bank_etihad_merchant_id || !row?.bank_etihad_api_secret) {
      return null;
    }

    const apiSecret = decryptPassword(row.bank_etihad_api_secret);
    const ccToken   = row.bank_etihad_cc_token ? decryptPassword(row.bank_etihad_cc_token) : null;

    if (!apiSecret) {
      logger.warn({ tenantId }, 'Bank al Etihad api_secret decrypt failed');
      return null;
    }
    if (row.bank_etihad_cc_token && !ccToken) {
      logger.warn({ tenantId }, 'Bank al Etihad cc_token decrypt failed');
      return null;
    }

    return {
      merchantId: row.bank_etihad_merchant_id.trim(),
      apiSecret,
      ccToken,
      host: String(row.bank_etihad_host || DEFAULT_HOST).trim() || DEFAULT_HOST,
    };
  } catch (err) {
    logger.error({ err, tenantId }, 'Failed to read Bank al Etihad credentials');
    return null;
  }
}

/**
 * Clear Bank al Etihad credentials for a tenant. Nulls the 4 BAE columns
 * and resets payment_provider to NULL.
 */
async function clearBankEtihadCredentials(tenantId) {
  await db.query(
    `UPDATE tenants
     SET bank_etihad_merchant_id = NULL,
         bank_etihad_api_secret  = NULL,
         bank_etihad_cc_token    = NULL,
         bank_etihad_host        = NULL,
         payment_provider        = NULL
     WHERE id = $1`,
    [Number(tenantId)]
  );
}

/**
 * Boolean helper — true if the tenant has usable Bank al Etihad credentials.
 */
async function hasBankEtihadCredentials(tenantId) {
  const creds = await getBankEtihadCredentials(tenantId);
  return Boolean(creds);
}

module.exports = {
  saveBankEtihadCredentials,
  getBankEtihadCredentials,
  clearBankEtihadCredentials,
  hasBankEtihadCredentials,
  DEFAULT_HOST,
};
