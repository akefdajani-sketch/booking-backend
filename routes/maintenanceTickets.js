'use strict';

// routes/maintenanceTickets.js
// PR-MAINT-1: Maintenance ticket system for rental properties.
//
// Mount in app.js:
//   app.use('/api/maintenance-tickets', require('./routes/maintenanceTickets'));
//
// Endpoints (all require tenant auth):
//   GET    /api/maintenance-tickets          — list tickets for a tenant
//   POST   /api/maintenance-tickets          — create a new ticket
//   GET    /api/maintenance-tickets/:id      — get one ticket
//   PATCH  /api/maintenance-tickets/:id      — update ticket (status, assignment, notes)
//   DELETE /api/maintenance-tickets/:id      — soft-delete a ticket
//
// Query params for GET list:
//   tenantSlug | tenantId  — required (tenant resolution)
//   status                 — filter: open | in_progress | resolved | closed | all
//   priority               — filter: low | medium | high | urgent
//   resourceId             — filter by resource/unit
//   limit                  — default 50, max 200
//   offset                 — pagination

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const logger  = require('../utils/logger');

const requireAppAuth            = require('../middleware/requireAppAuth');
const { requireTenant }         = require('../middleware/requireTenant');
const requireAdminOrTenantRole  = require('../middleware/requireAdminOrTenantRole');
const { getTenantIdFromSlug }   = require('../utils/tenants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve tenantId from either query.tenantSlug or query.tenantId. */
async function resolveTenantId(query) {
  const slug    = query?.tenantSlug ?? query?.slug ?? null;
  const rawId   = query?.tenantId   ?? query?.tenant_id ?? null;

  if (rawId != null && String(rawId).trim() !== '') {
    const n = Number(rawId);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (slug) {
    return await getTenantIdFromSlug(String(slug).trim());
  }
  return null;
}

const VALID_STATUSES   = new Set(['open', 'in_progress', 'resolved', 'closed']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

function clamp(v, max) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function assertTicketBelongsTenant(ticket, tenantId) {
  return ticket && Number(ticket.tenant_id) === Number(tenantId);
}

// ---------------------------------------------------------------------------
// GET /api/maintenance-tickets
// List tickets for a tenant with optional filters.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.query);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantSlug or tenantId is required.' });
    }

    const status     = String(req.query.status     || 'all').toLowerCase();
    const priority   = String(req.query.priority   || '').toLowerCase();
    const resourceId = req.query.resourceId ? Number(req.query.resourceId) : null;
    const rawLimit   = Number(req.query.limit  || 50);
    const rawOffset  = Number(req.query.offset || 0);
    const limit      = Math.min(Math.max(rawLimit, 1), 200);
    const offset     = Math.max(rawOffset, 0);

    const conditions = ['t.tenant_id = $1', 't.is_active = TRUE'];
    const params     = [tenantId];
    let   pi         = 2; // param index

    if (status !== 'all' && VALID_STATUSES.has(status)) {
      conditions.push(`t.status = $${pi++}`);
      params.push(status);
    }

    if (priority && VALID_PRIORITIES.has(priority)) {
      conditions.push(`t.priority = $${pi++}`);
      params.push(priority);
    }

    if (resourceId && Number.isFinite(resourceId)) {
      conditions.push(`t.resource_id = $${pi++}`);
      params.push(resourceId);
    }

    const where = conditions.join(' AND ');

    const r = await db.query(
      `SELECT
         t.id,
         t.tenant_id,
         t.resource_id,
         t.booking_id,
         t.title,
         t.description,
         t.priority,
         t.status,
         t.assigned_to_name,
         t.assigned_to_email,
         t.reported_by_name,
         t.reported_by_email,
         t.resolution_notes,
         t.resolved_at,
         t.created_at,
         t.updated_at,
         r.name AS resource_name
       FROM maintenance_tickets t
       LEFT JOIN resources r ON r.id = t.resource_id
       WHERE ${where}
       ORDER BY
         CASE t.priority
           WHEN 'urgent' THEN 1
           WHEN 'high'   THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low'    THEN 4
           ELSE 5
         END,
         t.created_at DESC
       LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    // Total count for pagination
    const countR = await db.query(
      `SELECT COUNT(*) AS total FROM maintenance_tickets t WHERE ${where}`,
      params
    );
    const total = Number(countR.rows?.[0]?.total ?? 0);

    return res.json({
      tickets:    r.rows,
      total,
      limit,
      offset,
      hasMore:    offset + limit < total,
    });
  } catch (err) {
    logger.error({ err }, 'GET /maintenance-tickets error');
    return res.status(500).json({ error: 'Failed to list maintenance tickets.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/maintenance-tickets
// Create a new ticket.
// ---------------------------------------------------------------------------
router.post(
  '/',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      if (!tenantId) return res.status(400).json({ error: 'Tenant required.' });

      const {
        title,
        description,
        priority     = 'medium',
        resourceId,
        bookingId,
        assignedToName,
        assignedToEmail,
        reportedByName,
        reportedByEmail,
      } = req.body || {};

      const safeTitle = clamp(title, 200);
      if (!safeTitle) return res.status(400).json({ error: 'title is required.' });

      const safePriority = VALID_PRIORITIES.has(String(priority).toLowerCase())
        ? String(priority).toLowerCase()
        : 'medium';

      const r = await db.query(
        `INSERT INTO maintenance_tickets
           (tenant_id, resource_id, booking_id, title, description, priority,
            assigned_to_name, assigned_to_email,
            reported_by_name, reported_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          tenantId,
          resourceId  ? Number(resourceId)  : null,
          bookingId   ? Number(bookingId)   : null,
          safeTitle,
          clamp(description, 2000),
          safePriority,
          clamp(assignedToName,  100),
          clamp(assignedToEmail, 200),
          clamp(reportedByName,  100),
          clamp(reportedByEmail, 200),
        ]
      );

      logger.info({ tenantId, ticketId: r.rows[0].id }, 'maintenance ticket created');
      return res.status(201).json({ ticket: r.rows[0] });
    } catch (err) {
      logger.error({ err }, 'POST /maintenance-tickets error');
      return res.status(500).json({ error: 'Failed to create maintenance ticket.' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/maintenance-tickets/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const tenantId = await resolveTenantId(req.query);
    if (!tenantId) return res.status(400).json({ error: 'tenantSlug or tenantId is required.' });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });

    const r = await db.query(
      `SELECT t.*, r.name AS resource_name
       FROM maintenance_tickets t
       LEFT JOIN resources r ON r.id = t.resource_id
       WHERE t.id = $1 AND t.is_active = TRUE`,
      [id]
    );

    const ticket = r.rows?.[0];
    if (!ticket || !assertTicketBelongsTenant(ticket, tenantId)) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    return res.json({ ticket });
  } catch (err) {
    logger.error({ err }, 'GET /maintenance-tickets/:id error');
    return res.status(500).json({ error: 'Failed to get ticket.' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/maintenance-tickets/:id
// Update status, priority, assignment, resolution notes.
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      if (!tenantId) return res.status(400).json({ error: 'Tenant required.' });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });

      // Verify ownership
      const existing = await db.query(
        'SELECT id, tenant_id, status FROM maintenance_tickets WHERE id=$1 AND is_active=TRUE',
        [id]
      );
      const ticket = existing.rows?.[0];
      if (!ticket || !assertTicketBelongsTenant(ticket, tenantId)) {
        return res.status(404).json({ error: 'Ticket not found.' });
      }

      const {
        title,
        description,
        status,
        priority,
        assignedToName,
        assignedToEmail,
        resolutionNotes,
        resourceId,
        bookingId,
        reportedByName,
        reportedByEmail,
      } = req.body || {};

      const setClauses = [];
      const values     = [];
      let   pi         = 1;

      const maybeSet = (col, val) => {
        if (val !== undefined) {
          setClauses.push(`${col} = $${pi++}`);
          values.push(val);
        }
      };

      if (title !== undefined)       maybeSet('title',             clamp(title, 200));
      if (description !== undefined) maybeSet('description',       clamp(description, 2000));
      if (resolutionNotes !== undefined) maybeSet('resolution_notes', clamp(resolutionNotes, 2000));
      if (assignedToName  !== undefined) maybeSet('assigned_to_name',  clamp(assignedToName, 100));
      if (assignedToEmail !== undefined) maybeSet('assigned_to_email', clamp(assignedToEmail, 200));
      if (reportedByName  !== undefined) maybeSet('reported_by_name',  clamp(reportedByName, 100));
      if (reportedByEmail !== undefined) maybeSet('reported_by_email', clamp(reportedByEmail, 200));
      if (resourceId !== undefined) maybeSet('resource_id', resourceId ? Number(resourceId) : null);
      if (bookingId  !== undefined) maybeSet('booking_id',  bookingId  ? Number(bookingId)  : null);

      if (priority !== undefined && VALID_PRIORITIES.has(String(priority).toLowerCase())) {
        maybeSet('priority', String(priority).toLowerCase());
      }

      if (status !== undefined && VALID_STATUSES.has(String(status).toLowerCase())) {
        const newStatus = String(status).toLowerCase();
        maybeSet('status', newStatus);
        // Auto-stamp resolved_at when moving to resolved/closed
        if ((newStatus === 'resolved' || newStatus === 'closed') && ticket.status !== newStatus) {
          setClauses.push(`resolved_at = $${pi++}`);
          values.push(new Date().toISOString());
        } else if (newStatus === 'open' || newStatus === 'in_progress') {
          setClauses.push(`resolved_at = $${pi++}`);
          values.push(null);
        }
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: 'No fields to update.' });
      }

      values.push(id); // WHERE id = $pi
      const r = await db.query(
        `UPDATE maintenance_tickets
         SET ${setClauses.join(', ')}, updated_at = NOW()
         WHERE id = $${pi}
         RETURNING *`,
        values
      );

      logger.info({ tenantId, ticketId: id, status }, 'maintenance ticket updated');
      return res.json({ ticket: r.rows[0] });
    } catch (err) {
      logger.error({ err }, 'PATCH /maintenance-tickets/:id error');
      return res.status(500).json({ error: 'Failed to update ticket.' });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/maintenance-tickets/:id  (soft delete)
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requireAppAuth,
  requireTenant,
  requireAdminOrTenantRole('staff'),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      if (!tenantId) return res.status(400).json({ error: 'Tenant required.' });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });

      const existing = await db.query(
        'SELECT id, tenant_id FROM maintenance_tickets WHERE id=$1 AND is_active=TRUE',
        [id]
      );
      const ticket = existing.rows?.[0];
      if (!ticket || !assertTicketBelongsTenant(ticket, tenantId)) {
        return res.status(404).json({ error: 'Ticket not found.' });
      }

      await db.query(
        'UPDATE maintenance_tickets SET is_active=FALSE, updated_at=NOW() WHERE id=$1',
        [id]
      );

      logger.info({ tenantId, ticketId: id }, 'maintenance ticket soft-deleted');
      return res.json({ deleted: true });
    } catch (err) {
      logger.error({ err }, 'DELETE /maintenance-tickets/:id error');
      return res.status(500).json({ error: 'Failed to delete ticket.' });
    }
  }
);

module.exports = router;
