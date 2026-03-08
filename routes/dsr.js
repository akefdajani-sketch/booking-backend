'use strict';

// routes/dsr.js
// PR-8: GDPR DSR + SOC-2 Audit Prep
//
// Data Subject Request (DSR) endpoints.
// Covers GDPR Articles 15 (access), 17 (erasure/right to be forgotten),
// and 20 (data portability).
//
// Public endpoints (customer-facing):
//   POST /api/dsr/request          — submit an access, erasure, or portability request
//   GET  /api/dsr/status/:token    — check DSR status by opaque token (future)
//
// Admin endpoints (tenant-owner only):
//   GET  /api/dsr                  — list DSR requests for tenant
//   PATCH /api/dsr/:id/status      — advance status (processing → completed/rejected)
//   GET  /api/dsr/:id/export       — export customer data package (Article 15/20)
//
// Erasure execution is intentionally manual (status=completed by owner)
// rather than automated, so the tenant can verify legal holds before deletion.

const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const requireGoogleAuth           = require('../middleware/requireGoogleAuth');
const { requireTenant }           = require('../middleware/requireTenant');
const requireAdminOrTenantRole    = require('../middleware/requireAdminOrTenantRole');
const { writeAuditEvent, EVENT_TYPES } = require('../utils/auditLog');
const logger   = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDsrTable() {
  // Gracefully no-op if migration has already run.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dsr_requests (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       INTEGER       NOT NULL,
        request_type    TEXT          NOT NULL CHECK (request_type IN ('access','erasure','portability')),
        requester_email TEXT          NOT NULL,
        status          TEXT          NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','rejected')),
        notes           TEXT,
        completed_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    logger.warn({ err }, 'dsr: could not ensure dsr_requests table (non-fatal)');
  }
}

// ─── POST /api/dsr/request ────────────────────────────────────────────────────
// Public — customer submits a DSR.

router.post('/request', requireTenant, async (req, res) => {
  try {
    await ensureDsrTable();

    const tenantId = req.tenantId;
    const { email, request_type } = req.body || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }

    const allowedTypes = ['access', 'erasure', 'portability'];
    if (!request_type || !allowedTypes.includes(request_type)) {
      return res.status(400).json({
        error: `request_type must be one of: ${allowedTypes.join(', ')}.`,
      });
    }

    const clean = email.toLowerCase().trim();

    // Idempotency: one pending/processing request per type per email per tenant
    const existing = await pool.query(
      `SELECT id FROM dsr_requests
        WHERE tenant_id=$1 AND requester_email=$2 AND request_type=$3
          AND status IN ('pending','processing')
        LIMIT 1`,
      [tenantId, clean, request_type]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'A pending request of this type already exists for this email.',
        dsr_id: existing.rows[0].id,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO dsr_requests (tenant_id, requester_email, request_type)
       VALUES ($1, $2, $3)
       RETURNING id, request_type, status, created_at`,
      [tenantId, clean, request_type]
    );

    const dsr = rows[0];

    // Audit
    const eventMap = {
      access:      EVENT_TYPES.DSR_ACCESS_REQUESTED,
      erasure:     EVENT_TYPES.DSR_ERASURE_REQUESTED,
      portability: EVENT_TYPES.DSR_PORTABILITY_REQUESTED,
    };
    await writeAuditEvent(req, {
      tenantId,
      actorEmail:   clean,
      actorRole:    'customer',
      eventType:    eventMap[request_type],
      resourceType: 'dsr_request',
      resourceId:   String(dsr.id),
    });

    return res.status(201).json({
      ok: true,
      dsr_id: dsr.id,
      status: dsr.status,
      request_type: dsr.request_type,
      message:
        request_type === 'erasure'
          ? 'Your erasure request has been received. The business will process it within 30 days.'
          : 'Your data request has been received. You will be notified when it is ready.',
    });
  } catch (err) {
    logger.error({ err }, 'POST /api/dsr/request error');
    return res.status(500).json({ error: 'Failed to submit DSR request.' });
  }
});

// ─── GET /api/dsr ─────────────────────────────────────────────────────────────
// Owner — list all DSR requests for tenant.

router.get(
  '/',
  requireGoogleAuth,
  requireTenant,
  requireAdminOrTenantRole('owner'),
  async (req, res) => {
    try {
      await ensureDsrTable();
      const tenantId = req.tenantId;
      const status   = req.query.status || null;
      const limit    = Math.min(Number(req.query.limit) || 50, 200);
      const offset   = Math.max(Number(req.query.offset) || 0, 0);

      let whereClause = 'WHERE tenant_id = $1';
      const params = [tenantId];

      if (status) {
        params.push(status);
        whereClause += ` AND status = $${params.length}`;
      }

      const countRes = await pool.query(
        `SELECT COUNT(*) FROM dsr_requests ${whereClause}`,
        params
      );

      params.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT id, request_type, requester_email, status, notes, completed_at, created_at, updated_at
           FROM dsr_requests
           ${whereClause}
           ORDER BY created_at DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      return res.json({
        data: rows,
        meta: {
          total:   Number(countRes.rows[0].count),
          limit,
          offset,
          hasMore: offset + rows.length < Number(countRes.rows[0].count),
        },
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/dsr error');
      return res.status(500).json({ error: 'Failed to load DSR requests.' });
    }
  }
);

// ─── PATCH /api/dsr/:id/status ────────────────────────────────────────────────
// Owner — advance DSR status.

router.patch(
  '/:id/status',
  requireGoogleAuth,
  requireTenant,
  requireAdminOrTenantRole('owner'),
  async (req, res) => {
    try {
      await ensureDsrTable();
      const tenantId = req.tenantId;
      const dsrId    = Number(req.params.id);
      const { status, notes } = req.body || {};

      if (!Number.isFinite(dsrId) || dsrId <= 0) {
        return res.status(400).json({ error: 'Invalid DSR id.' });
      }

      const allowed = ['processing', 'completed', 'rejected'];
      if (!status || !allowed.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}.` });
      }

      const completedAt = status === 'completed' ? new Date().toISOString() : null;

      const { rows } = await pool.query(
        `UPDATE dsr_requests
            SET status=$1, notes=$2, completed_at=$3, updated_at=NOW()
          WHERE id=$4 AND tenant_id=$5
          RETURNING id, status, request_type, requester_email`,
        [status, notes || null, completedAt, dsrId, tenantId]
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'DSR request not found.' });
      }

      const dsr = rows[0];

      await writeAuditEvent(req, {
        tenantId,
        actorEmail:   req.googleUser?.email || 'unknown',
        actorRole:    'owner',
        eventType:    status === 'completed' ? EVENT_TYPES.DSR_COMPLETED : EVENT_TYPES.DSR_REJECTED,
        resourceType: 'dsr_request',
        resourceId:   String(dsr.id),
        meta:         { status, request_type: dsr.request_type },
      });

      return res.json({ ok: true, dsr });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/dsr/:id/status error');
      return res.status(500).json({ error: 'Failed to update DSR status.' });
    }
  }
);

// ─── GET /api/dsr/:id/export ──────────────────────────────────────────────────
// Owner — export customer data package for Article 15/20 compliance.

router.get(
  '/:id/export',
  requireGoogleAuth,
  requireTenant,
  requireAdminOrTenantRole('owner'),
  async (req, res) => {
    try {
      await ensureDsrTable();
      const tenantId = req.tenantId;
      const dsrId    = Number(req.params.id);

      if (!Number.isFinite(dsrId) || dsrId <= 0) {
        return res.status(400).json({ error: 'Invalid DSR id.' });
      }

      // Load the DSR request
      const dsrRes = await pool.query(
        `SELECT * FROM dsr_requests WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [dsrId, tenantId]
      );
      if (!dsrRes.rows.length) {
        return res.status(404).json({ error: 'DSR request not found.' });
      }

      const dsr = dsrRes.rows[0];
      if (!['access', 'portability'].includes(dsr.request_type)) {
        return res.status(400).json({ error: 'Export is only available for access or portability requests.' });
      }

      const email = dsr.requester_email;

      // Collect customer data
      const [custRes, bookingsRes, membershipsRes] = await Promise.all([
        pool.query(
          `SELECT id, name, email, phone, created_at FROM customers
            WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
          [tenantId, email]
        ),
        pool.query(
          `SELECT b.id, b.start_time, b.end_time, b.status, s.name as service_name
             FROM bookings b
             LEFT JOIN services s ON s.id = b.service_id
            WHERE b.tenant_id=$1 AND b.customer_id IN (
              SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)
            )
            ORDER BY b.created_at DESC`,
          [tenantId, email]
        ),
        pool.query(
          `SELECT cm.id, mp.name as plan_name, cm.status, cm.created_at
             FROM customer_memberships cm
             LEFT JOIN membership_plans mp ON mp.id = cm.membership_plan_id
            WHERE cm.tenant_id=$1 AND cm.customer_id IN (
              SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)
            )`,
          [tenantId, email]
        ).catch(() => ({ rows: [] })), // graceful if table missing
      ]);

      // Audit the export
      await writeAuditEvent(req, {
        tenantId,
        actorEmail:   req.googleUser?.email || 'unknown',
        actorRole:    'owner',
        eventType:    EVENT_TYPES.CUSTOMER_DATA_EXPORTED,
        resourceType: 'customer',
        resourceId:   custRes.rows[0]?.id ? String(custRes.rows[0].id) : null,
        meta:         { dsr_id: dsrId, request_type: dsr.request_type },
      });

      return res.json({
        export_meta: {
          generated_at:  new Date().toISOString(),
          dsr_id:        dsrId,
          request_type:  dsr.request_type,
          requester:     email,
          gdpr_basis:    dsr.request_type === 'access' ? 'Article 15' : 'Article 20',
        },
        customer:    custRes.rows[0] || null,
        bookings:    bookingsRes.rows,
        memberships: membershipsRes.rows,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/dsr/:id/export error');
      return res.status(500).json({ error: 'Failed to export customer data.' });
    }
  }
);

module.exports = router;
