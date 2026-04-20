'use strict';

// utils/twilioCredentials.js
// PR 145: Resolve Twilio Programmable Messaging credentials for a given tenant.
//
// Mirrors utils/whatsappCredentials.js exactly — same encryption key
// (TENANT_CREDS_KEY), same AES-256-GCM scheme, same env-var fallback pattern.
//
// Priority order:
//   1. Tenant DB record (twilio_account_sid + decrypted twilio_auth_token + twilio_from_number + messaging_service_sid)
//   2. Env var fallback (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER + TWILIO_MESSAGING_SERVICE_SID)
//
// Usage:
//   const { getTwilioCredentials, isTwilioEnabledForTenant } = require('./twilioCredentials');
//   const creds = await getTwilioCredentials(tenantId);
//   if (!creds) return; // Twilio not configured for this tenant

const crypto = require('crypto');
const db     = require('../db');
const logger = require('./logger');

const ALGO = 'aes-256-gcm';

// ─── Encryption helpers (shared logic with whatsappCredentials) ───────────────

function getEncKey() {
  const hex = String(process.env.TENANT_CREDS_KEY || '').trim();
  if (hex.length !== 64) return null;
  try { return Buffer.from(hex, 'hex'); } catch { return null; }
}

function encryptToken(plaintext) {
  const key = getEncKey();
  if (!key) throw new Error('TENANT_CREDS_KEY not set or invalid (need 64 hex chars). Run: openssl rand -hex 32');

  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();

  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decryptToken(stored) {
  if (!stored) return null;
  const key = getEncKey();
  if (!key) {
    logger.warn('TENANT_CREDS_KEY missing — cannot decrypt tenant Twilio token');
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
    logger.error({ err }, 'Failed to decrypt tenant Twilio token');
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve Twilio credentials for a tenant.
 * Returns DB record if available, falls back to env vars.
 *
 * @param {number|string|null} tenantId
 * @returns {Promise<{ accountSid, authToken, fromNumber, messagingServiceSid, source: 'db'|'env' } | null>}
 */
async function getTwilioCredentials(tenantId) {
  // ── Step 1: Try DB record ──────────────────────────────────────────────────
  if (tenantId) {
    try {
      const { rows } = await db.query(
        `SELECT twilio_account_sid,
                twilio_auth_token,
                twilio_from_number,
                twilio_messaging_service_sid
         FROM tenants WHERE id = $1 LIMIT 1`,
        [Number(tenantId)]
      );
      const row = rows[0];

      if (row?.twilio_account_sid && row?.twilio_auth_token) {
        const decrypted = decryptToken(row.twilio_auth_token);
        if (decrypted) {
          return {
            accountSid:           row.twilio_account_sid.trim(),
            authToken:            decrypted,
            fromNumber:           row.twilio_from_number  ? row.twilio_from_number.trim()           : null,
            messagingServiceSid:  row.twilio_messaging_service_sid ? row.twilio_messaging_service_sid.trim() : null,
            source:               'db',
          };
        }
        logger.warn({ tenantId }, 'Tenant has Twilio token but decryption failed — falling back to env vars');
      }
    } catch (err) {
      logger.error({ err, tenantId }, 'Failed to read tenant Twilio credentials from DB — falling back to env vars');
    }
  }

  // ── Step 2: Env var fallback ───────────────────────────────────────────────
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken  = String(process.env.TWILIO_AUTH_TOKEN  || '').trim();
  const fromNumber = String(process.env.TWILIO_FROM_NUMBER || '').trim();
  const messagingServiceSid = String(process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim();

  if (accountSid && authToken && fromNumber) {
    return {
      accountSid,
      authToken,
      fromNumber,
      messagingServiceSid: messagingServiceSid || null,
      source: 'env',
    };
  }

  return null;
}

/**
 * Returns true if Twilio is usable for a given tenant
 * (DB credentials or env var fallback).
 */
async function isTwilioEnabledForTenant(tenantId) {
  const creds = await getTwilioCredentials(tenantId);
  return Boolean(creds);
}

/**
 * Save (or update) encrypted Twilio credentials for a tenant.
 * Called by the setup API route after a live verify.
 *
 * @param {number} tenantId
 * @param {object} creds
 * @param {string} creds.accountSid           — ACxxxx… 34 chars; stored plain
 * @param {string} creds.authToken            — 32 char secret; AES-encrypted
 * @param {string} creds.fromNumber           — E.164 (e.g. +962XXXXXXXX); stored plain
 * @param {string|null} creds.messagingServiceSid — MGxxxx… optional; stored plain
 */
async function saveTwilioCredentials(tenantId, { accountSid, authToken, fromNumber, messagingServiceSid }) {
  const encrypted = encryptToken(authToken);

  await db.query(
    `UPDATE tenants
     SET twilio_account_sid            = $1,
         twilio_auth_token             = $2,
         twilio_from_number            = $3,
         twilio_messaging_service_sid  = $4,
         twilio_active                 = true
     WHERE id = $5`,
    [
      String(accountSid).trim(),
      encrypted,
      String(fromNumber).trim(),
      messagingServiceSid ? String(messagingServiceSid).trim() : null,
      Number(tenantId),
    ]
  );
}

/**
 * Clear Twilio credentials for a tenant.
 * Disables their Twilio integration without affecting anything else.
 */
async function clearTwilioCredentials(tenantId) {
  await db.query(
    `UPDATE tenants
     SET twilio_account_sid            = NULL,
         twilio_auth_token             = NULL,
         twilio_from_number            = NULL,
         twilio_messaging_service_sid  = NULL,
         twilio_active                 = false
     WHERE id = $1`,
    [Number(tenantId)]
  );
}

module.exports = {
  getTwilioCredentials,
  isTwilioEnabledForTenant,
  saveTwilioCredentials,
  clearTwilioCredentials,
  encryptToken,  // exported for tests
  decryptToken,  // exported for tests
};
