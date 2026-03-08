'use strict';

// utils/auditLog.js
// PR-8: GDPR DSR + SOC-2 Audit Prep
//
// Append-only audit event writer.
// Usage:
//   const { writeAuditEvent } = require('../utils/auditLog');
//   await writeAuditEvent(req, {
//     tenantId: 1,
//     actorEmail: 'owner@example.com',
//     actorRole: 'owner',
//     eventType: 'booking.cancelled',
//     resourceType: 'booking',
//     resourceId: String(bookingId),
//     meta: { reason: 'no-show' },
//   });
//
// Design principles:
//   - NEVER throws — audit failures must not break the main request flow.
//   - NEVER logs PII into the meta column (use resource ids, not names/emails).
//   - table is append-only; no UPDATE or DELETE is ever issued here.

const { pool } = require('../db');
const logger = require('./logger');

// ─── Event type registry ──────────────────────────────────────────────────────
// Centralised list prevents typos in callers.

const EVENT_TYPES = Object.freeze({
  // Bookings
  BOOKING_CREATED:       'booking.created',
  BOOKING_UPDATED:       'booking.updated',
  BOOKING_CANCELLED:     'booking.cancelled',
  // Customers
  CUSTOMER_CREATED:      'customer.created',
  CUSTOMER_DELETED:      'customer.deleted',
  CUSTOMER_DATA_EXPORTED:'customer.data_exported',
  // Staff
  STAFF_CREATED:         'staff.created',
  STAFF_DELETED:         'staff.deleted',
  // Services
  SERVICE_CREATED:       'service.created',
  SERVICE_DELETED:       'service.deleted',
  // Memberships
  MEMBERSHIP_CREATED:    'membership.created',
  MEMBERSHIP_CANCELLED:  'membership.cancelled',
  // DSR
  DSR_ACCESS_REQUESTED:  'dsr.access_requested',
  DSR_ERASURE_REQUESTED: 'dsr.erasure_requested',
  DSR_PORTABILITY_REQUESTED: 'dsr.portability_requested',
  DSR_COMPLETED:         'dsr.completed',
  DSR_REJECTED:          'dsr.rejected',
  // Tenant
  TENANT_SETTINGS_UPDATED: 'tenant.settings_updated',
  // Auth
  AUTH_LOGIN:            'auth.login',
  AUTH_LOGOUT:           'auth.logout',
});

// ─── Writer ───────────────────────────────────────────────────────────────────

/**
 * @param {import('express').Request|null} req  - Express request (for IP/UA/requestId). Pass null in background jobs.
 * @param {{
 *   tenantId:     number,
 *   actorEmail:   string,
 *   actorRole?:   string,
 *   eventType:    string,
 *   resourceType?: string,
 *   resourceId?:  string,
 *   meta?:        object,
 * }} event
 * @returns {Promise<void>}
 */
async function writeAuditEvent(req, event) {
  try {
    const {
      tenantId,
      actorEmail,
      actorRole   = null,
      eventType,
      resourceType = null,
      resourceId   = null,
      meta         = {},
    } = event;

    if (!tenantId || !actorEmail || !eventType) {
      logger.warn({ event }, 'auditLog: skipping event — missing required fields');
      return;
    }

    const ipAddress  = req?.ip ?? req?.headers?.['x-forwarded-for'] ?? null;
    const userAgent  = req?.headers?.['user-agent'] ?? null;
    const requestId  = req?.requestId ?? req?.headers?.['x-request-id'] ?? null;

    await pool.query(
      `INSERT INTO audit_log
         (tenant_id, actor_email, actor_role, event_type,
          resource_type, resource_id, meta, ip_address, user_agent, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tenantId,
        String(actorEmail).toLowerCase().trim(),
        actorRole,
        eventType,
        resourceType,
        resourceId ? String(resourceId) : null,
        JSON.stringify(meta),
        ipAddress,
        userAgent,
        requestId,
      ]
    );
  } catch (err) {
    // Audit failures must NEVER crash the main request.
    logger.error({ err }, 'auditLog: failed to write audit event (non-fatal)');
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { writeAuditEvent, EVENT_TYPES };
