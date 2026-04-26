'use strict';

// routes/classes/sessions.js
// G1: GET /api/classes/sessions — list class sessions for a tenant.
//     GET /api/classes/sessions/:id — single session with derived counts.
//
// Tenant-scoped via requireTenant. Read role: any authenticated tenant member.
// Public-facing variant (anonymous customer) lives at /api/public-classes/* (later).

const db = require('../../db');
const logger = require('../../utils/logger');

module.exports = function mount(router) {
  // ─── List sessions ────────────────────────────────────────────────────────
  router.get('/sessions', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'Invalid tenant.' });

      // Filters
      const fromDate = req.query.fromDate ? String(req.query.fromDate) : null;
      const toDate   = req.query.toDate   ? String(req.query.toDate)   : null;
      const serviceId    = req.query.serviceId    ? Number(req.query.serviceId)    : null;
      const instructorId = req.query.instructorId ? Number(req.query.instructorId) : null;
      const status   = req.query.status   ? String(req.query.status)   : null;
      const limitRaw = req.query.limit ? Number(req.query.limit) : 100;
      const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100));
      const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
      const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

      const where = ['cs.tenant_id = $1'];
      const params = [tenantId];
      let p = 2;
      if (fromDate)     { where.push(`cs.start_time >= $${p++}`); params.push(fromDate); }
      if (toDate)       { where.push(`cs.start_time <  $${p++}`); params.push(toDate); }
      if (serviceId)    { where.push(`cs.service_id  =  $${p++}`); params.push(serviceId); }
      if (instructorId) { where.push(`cs.instructor_id = $${p++}`); params.push(instructorId); }
      if (status)       { where.push(`cs.status = $${p++}`);       params.push(status); }

      const sql = `
        SELECT
          cs.id, cs.tenant_id, cs.service_id, cs.instructor_id, cs.resource_id,
          cs.start_time, cs.end_time, cs.capacity, cs.status, cs.notes,
          cs.created_at, cs.updated_at,
          s.name        AS service_name,
          i.name        AS instructor_name,
          r.name        AS resource_name,
          COALESCE((
            SELECT COUNT(*)::int
            FROM class_session_seats seats
            WHERE seats.session_id = cs.id
              AND seats.tenant_id  = cs.tenant_id
              AND seats.status IN ('confirmed','checked_in')
          ), 0) AS booked_count,
          COALESCE((
            SELECT COUNT(*)::int
            FROM class_session_waitlist w
            WHERE w.session_id = cs.id
              AND w.tenant_id  = cs.tenant_id
              AND w.status = 'waiting'
          ), 0) AS waitlist_count
        FROM class_sessions cs
        LEFT JOIN services    s ON s.id = cs.service_id    AND s.tenant_id = cs.tenant_id
        LEFT JOIN instructors i ON i.id = cs.instructor_id AND i.tenant_id = cs.tenant_id
        LEFT JOIN resources   r ON r.id = cs.resource_id   AND r.tenant_id = cs.tenant_id
        WHERE ${where.join(' AND ')}
        ORDER BY cs.start_time ASC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const result = await db.query(sql, params);
      const sessions = result.rows.map((row) => ({
        ...row,
        available_seats: Math.max(0, Number(row.capacity) - Number(row.booked_count)),
      }));

      return res.json({ sessions, count: sessions.length, limit, offset });
    } catch (err) {
      logger.error({ err: err.message }, 'GET /classes/sessions failed');
      return res.status(500).json({ error: 'Failed to load sessions.' });
    }
  });

  // ─── Get single session with seats + waitlist roster ──────────────────────
  router.get('/sessions/:id', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const sessionId = Number(req.params.id);
      if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'Invalid tenant.' });
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({ error: 'Invalid session id.' });
      }

      const sRes = await db.query(
        `SELECT
           cs.*,
           s.name AS service_name,
           i.name AS instructor_name,
           r.name AS resource_name
         FROM class_sessions cs
         LEFT JOIN services    s ON s.id = cs.service_id    AND s.tenant_id = cs.tenant_id
         LEFT JOIN instructors i ON i.id = cs.instructor_id AND i.tenant_id = cs.tenant_id
         LEFT JOIN resources   r ON r.id = cs.resource_id   AND r.tenant_id = cs.tenant_id
         WHERE cs.id = $1 AND cs.tenant_id = $2`,
        [sessionId, tenantId]
      );
      if (sRes.rows.length === 0) {
        return res.status(404).json({ error: 'Session not found.' });
      }
      const session = sRes.rows[0];

      // Roster: confirmed + checked-in seats
      const seatsRes = await db.query(
        `SELECT
           seats.id, seats.customer_id, seats.status,
           seats.amount_paid, seats.currency_code,
           seats.checked_in_at, seats.checked_in_by,
           seats.created_at,
           c.name  AS customer_name,
           c.phone AS customer_phone,
           c.email AS customer_email
         FROM class_session_seats seats
         LEFT JOIN customers c
           ON c.id = seats.customer_id AND c.tenant_id = seats.tenant_id
         WHERE seats.session_id = $1 AND seats.tenant_id = $2
           AND seats.status IN ('confirmed','checked_in')
         ORDER BY seats.created_at ASC`,
        [sessionId, tenantId]
      );

      // Waitlist
      const waitRes = await db.query(
        `SELECT
           w.id, w.customer_id, w.position, w.status, w.created_at,
           c.name AS customer_name
         FROM class_session_waitlist w
         LEFT JOIN customers c
           ON c.id = w.customer_id AND c.tenant_id = w.tenant_id
         WHERE w.session_id = $1 AND w.tenant_id = $2
           AND w.status = 'waiting'
         ORDER BY w.position ASC, w.created_at ASC`,
        [sessionId, tenantId]
      );

      const bookedCount = seatsRes.rows.length;
      const availableSeats = Math.max(0, Number(session.capacity) - bookedCount);

      return res.json({
        session: {
          ...session,
          booked_count: bookedCount,
          available_seats: availableSeats,
          waitlist_count: waitRes.rows.length,
        },
        seats: seatsRes.rows,
        waitlist: waitRes.rows,
      });
    } catch (err) {
      logger.error({ err: err.message, sessionId: req.params.id }, 'GET /classes/sessions/:id failed');
      return res.status(500).json({ error: 'Failed to load session.' });
    }
  });
};
