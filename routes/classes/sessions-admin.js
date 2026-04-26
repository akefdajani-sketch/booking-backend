'use strict';

// routes/classes/sessions-admin.js
// G1: Admin/staff endpoints for class sessions.
//   POST  /api/classes/sessions             — create
//   PATCH /api/classes/sessions/:id         — update (capacity, status, etc.)
//   POST  /api/classes/sessions/:id/cancel  — cancel + free seats

const db = require('../../db');
const logger = require('../../utils/logger');

module.exports = function mount(router) {
  // ─── Create session ──────────────────────────────────────────────────────
  router.post('/sessions', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const body = req.body || {};

      const serviceId = Number(body.service_id);
      const startTime = body.start_time;
      const endTime = body.end_time;
      const capacityIn = body.capacity != null ? Number(body.capacity) : null;
      const instructorId = body.instructor_id != null ? Number(body.instructor_id) : null;
      const resourceId = body.resource_id != null ? Number(body.resource_id) : null;
      const notes = body.notes ?? null;

      if (!Number.isInteger(serviceId) || serviceId <= 0) {
        return res.status(400).json({ error: 'service_id is required.' });
      }
      if (!startTime || !endTime) {
        return res.status(400).json({ error: 'start_time and end_time are required.' });
      }
      if (new Date(endTime) <= new Date(startTime)) {
        return res.status(400).json({ error: 'end_time must be after start_time.' });
      }

      // Look up the service to:
      // 1. confirm tenant ownership
      // 2. confirm it's a class
      // 3. fall back to default_capacity if not supplied
      const sRes = await db.query(
        `SELECT id, is_class, default_capacity FROM services
         WHERE id = $1 AND tenant_id = $2`,
        [serviceId, tenantId]
      );
      if (sRes.rows.length === 0) {
        return res.status(400).json({ error: 'service_not_found' });
      }
      const svc = sRes.rows[0];
      if (!svc.is_class) {
        return res.status(400).json({ error: 'service_is_not_a_class' });
      }
      const capacity = capacityIn ?? svc.default_capacity;
      if (!Number.isInteger(capacity) || capacity <= 0) {
        return res.status(400).json({ error: 'capacity_required_or_invalid' });
      }

      const ins = await db.query(
        `INSERT INTO class_sessions
           (tenant_id, service_id, instructor_id, resource_id,
            start_time, end_time, capacity, status, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8, NOW(), NOW())
         RETURNING *`,
        [tenantId, serviceId, instructorId, resourceId, startTime, endTime, capacity, notes]
      );
      logger.info(
        { tenantId, sessionId: ins.rows[0].id, serviceId, capacity },
        'class session created'
      );
      return res.status(201).json({ session: ins.rows[0] });
    } catch (err) {
      logger.error({ err: err.message }, 'create session failed');
      return res.status(500).json({ error: 'Failed to create session.' });
    }
  });

  // ─── Update session ──────────────────────────────────────────────────────
  router.patch('/sessions/:id', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      const body = req.body || {};

      // Capacity reduction sanity: don't let a tenant set capacity below
      // the current confirmed seat count, that would put us in an
      // inconsistent state.
      if (body.capacity != null) {
        const cap = Number(body.capacity);
        if (!Number.isInteger(cap) || cap <= 0) {
          return res.status(400).json({ error: 'invalid_capacity' });
        }
        const cnt = await db.query(
          `SELECT COUNT(*)::int AS n FROM class_session_seats
           WHERE session_id = $1 AND tenant_id = $2
             AND status IN ('confirmed','checked_in')`,
          [id, tenantId]
        );
        if ((cnt.rows[0]?.n ?? 0) > cap) {
          return res.status(409).json({
            error: 'capacity_below_booked',
            booked: cnt.rows[0].n,
          });
        }
      }

      const fields = [];
      const params = [];
      let p = 1;
      const setIf = (col, val) => {
        if (val !== undefined) { fields.push(`${col} = $${p++}`); params.push(val); }
      };
      setIf('capacity', body.capacity != null ? Number(body.capacity) : undefined);
      setIf('start_time', body.start_time);
      setIf('end_time', body.end_time);
      setIf('instructor_id', body.instructor_id !== undefined ? (body.instructor_id != null ? Number(body.instructor_id) : null) : undefined);
      setIf('resource_id', body.resource_id !== undefined ? (body.resource_id != null ? Number(body.resource_id) : null) : undefined);
      setIf('notes', body.notes);

      if (fields.length === 0) return res.status(400).json({ error: 'No updatable fields supplied.' });

      fields.push(`updated_at = NOW()`);
      params.push(id, tenantId);
      const r = await db.query(
        `UPDATE class_sessions SET ${fields.join(', ')}
         WHERE id = $${p++} AND tenant_id = $${p}
         RETURNING *`,
        params
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Session not found.' });
      return res.json({ session: r.rows[0] });
    } catch (err) {
      logger.error({ err: err.message }, 'update session failed');
      return res.status(500).json({ error: 'Failed to update session.' });
    }
  });

  // ─── Cancel session ──────────────────────────────────────────────────────
  router.post('/sessions/:id/cancel', async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      const reason = (req.body && req.body.reason) || null;

      // Set session status
      const sRes = await client.query(
        `UPDATE class_sessions
         SET status = 'cancelled',
             cancellation_reason = $1,
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3
           AND status = 'scheduled'
         RETURNING *`,
        [reason, id, tenantId]
      );
      if (sRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'session_not_cancellable' });
      }

      // Cancel all confirmed/checked_in seats
      const seatsRes = await client.query(
        `UPDATE class_session_seats
         SET status = 'cancelled',
             cancelled_at = NOW(),
             cancelled_by = 'system_session_cancelled',
             updated_at = NOW()
         WHERE session_id = $1 AND tenant_id = $2
           AND status IN ('confirmed','checked_in')
         RETURNING id`,
        [id, tenantId]
      );

      // Cancel all waiting waitlist entries
      const waitRes = await client.query(
        `UPDATE class_session_waitlist
         SET status = 'cancelled',
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE session_id = $1 AND tenant_id = $2 AND status = 'waiting'
         RETURNING id`,
        [id, tenantId]
      );

      await client.query('COMMIT');
      logger.info(
        {
          tenantId, sessionId: id,
          seatsCancelled: seatsRes.rows.length,
          waitlistCancelled: waitRes.rows.length,
        },
        'class session cancelled'
      );
      return res.json({
        session: sRes.rows[0],
        seats_cancelled: seatsRes.rows.length,
        waitlist_cancelled: waitRes.rows.length,
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* */ }
      logger.error({ err: err.message }, 'cancel session failed');
      return res.status(500).json({ error: 'Failed to cancel session.' });
    } finally {
      client.release();
    }
  });
};
