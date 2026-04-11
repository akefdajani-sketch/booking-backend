'use strict';

// utils/whatsappCredentials.js
// WA-1: Resolve WhatsApp Business Cloud API credentials for a given tenant.
//
// Priority order:
//   1. Tenant DB record (whatsapp_phone_number_id + decrypted whatsapp_access_token)
//   2. Env var fallback (WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN)
//
// The fallback covers any tenant that hasn't yet saved credentials via the
// setup screen, keeping existing behaviour with zero disruption.
//
// Encryption:
//   Tokens are stored AES-256-GCM encrypted using the same TENANT_CREDS_KEY
//   used for payment credentials. Set TENANT_CREDS_KEY to a 64-char hex string.
//   Generate: openssl rand -hex 32
//
// Usage:
//   const { getWhatsAppCredentials, isWhatsAppEnabledForTenant } = require('./whatsappCredentials');
//   const creds = await getWhatsAppCredentials(tenantId);
//   if (!creds) return; // WhatsApp not configured for this tenant

const crypto = require('crypto');
const db     = require('../db');
const logger = require('./logger');

const ALGO = 'aes-256-gcm';

// ─── Encryption helpers (shared logic with networkCredentials) ─────────────────

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
    logger.warn('TENANT_CREDS_KEY missing — cannot decrypt tenant WhatsApp token');
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
    logger.error({ err }, 'Failed to decrypt tenant WhatsApp token');
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve WhatsApp credentials for a tenant.
 * Returns DB record if available, falls back to env vars.
 *
 * @param {number|string|null} tenantId
 * @returns {Promise<{ phoneNumberId: string, accessToken: string, source: 'db'|'env' } | null>}
 */
async function getWhatsAppCredentials(tenantId) {
  // ── Step 1: Try DB record ──────────────────────────────────────────────────
  if (tenantId) {
    try {
      const { rows } = await db.query(
        `SELECT whatsapp_phone_number_id, whatsapp_access_token
         FROM tenants WHERE id = $1 LIMIT 1`,
        [Number(tenantId)]
      );
      const row = rows[0];

      if (row?.whatsapp_phone_number_id && row?.whatsapp_access_token) {
        const decrypted = decryptToken(row.whatsapp_access_token);
        if (decrypted) {
          return {
            phoneNumberId: row.whatsapp_phone_number_id.trim(),
            accessToken:   decrypted,
            source:        'db',
          };
        }
        logger.warn({ tenantId }, 'Tenant has WhatsApp token but decryption failed — falling back to env vars');
      }
    } catch (err) {
      logger.error({ err, tenantId }, 'Failed to read tenant WhatsApp credentials from DB — falling back to env vars');
    }
  }

  // ── Step 2: Env var fallback ───────────────────────────────────────────────
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const accessToken   = String(process.env.WHATSAPP_ACCESS_TOKEN    || '').trim();

  if (phoneNumberId && accessToken) {
    return { phoneNumberId, accessToken, source: 'env' };
  }

  return null;
}

/**
 * Returns true if WhatsApp is usable for a given tenant
 * (DB credentials or env var fallback).
 *
 * @param {number|string|null} tenantId
 */
async function isWhatsAppEnabledForTenant(tenantId) {
  const creds = await getWhatsAppCredentials(tenantId);
  return Boolean(creds);
}

/**
 * Save (or update) encrypted WhatsApp credentials for a tenant.
 * Called by the setup API route.
 *
 * @param {number} tenantId
 * @param {string} phoneNumberId  plain text — stored as-is (not secret)
 * @param {string} accessToken    plain text — will be AES encrypted before storage
 */
async function saveWhatsAppCredentials(tenantId, phoneNumberId, accessToken) {
  const encrypted = encryptToken(accessToken);

  await db.query(
    `UPDATE tenants
     SET whatsapp_phone_number_id = $1,
         whatsapp_access_token    = $2,
         whatsapp_active          = true,
         updated_at               = NOW()
     WHERE id = $3`,
    [
      String(phoneNumberId).trim(),
      encrypted,
      Number(tenantId),
    ]
  );
}

/**
 * Clear WhatsApp credentials for a tenant.
 * Disables their WhatsApp integration without affecting anything else.
 */
async function clearWhatsAppCredentials(tenantId) {
  await db.query(
    `UPDATE tenants
     SET whatsapp_phone_number_id = NULL,
         whatsapp_access_token    = NULL,
         whatsapp_active          = false,
         updated_at               = NOW()
     WHERE id = $1`,
    [Number(tenantId)]
  );
}

module.exports = {
  getWhatsAppCredentials,
  isWhatsAppEnabledForTenant,
  saveWhatsAppCredentials,
  clearWhatsAppCredentials,
  encryptToken,  // exported for tests
  decryptToken,  // exported for tests
};
