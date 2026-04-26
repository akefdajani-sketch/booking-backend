'use strict';

// routes/classes/seats.js
// G1: Seat operations.
//   POST   /api/classes/sessions/:id/seats           — book a seat
//   DELETE /api/classes/sessions/:id/seats/:seatId   — cancel a seat (auto-promotes waitlist #1)
//   POST   /api/classes/sessions/:id/seats/:seatId/check-in
//
//   POST   /api/classes/sessions/:id/waitlist        — join waitlist
//   DELETE /api/classes/sessions/:id/waitlist/:wid   — leave waitlist

const logger = require('../../utils/logger');
const db = require('../../db');
const {
  bookSeat, cancelSeat, joinWaitlist, checkIn,
} = require('../../utils/classSeats');

module.exports = function mount(router) {
  // ─── Book a seat ──────────────────────────────────────────────────────────
  router.post('/sessions/:id/seats', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({ error: 'Invalid session id.' });
      }
      const body = req.body || {};
      const customerId = Number(body.customer_id ?? body.customerId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        return res.status(400).json({ error: 'customer_id is required.' });
      }
      const bookingId = body.booking_id != null ? Number(body.booking_id) : null;
      const amountPaid = Number(body.amount_paid ?? 0);
      const currencyCode = body.currency_code ?? null;

      const result = await bookSeat({
        tenantId, sessionId, customerId, bookingId, amountPaid, currencyCode,
      });

      if (!result.ok) {
        switch (result.code) {
          case 'session_not_found':
            return res.status(404).json({ error: result.code });
          case 'session_cancelled':
            return res.status(409).json({ error: result.code });
          case 'session_full':
            return res.status(409).json({
              error: result.code,
              waitlist_eligible: result.waitlist_eligible,
            });
          case 'duplicate_seat':
            return res.status(409).json({ error: result.code });
          default:
            return res.status(400).json({ error: result.code || 'unknown_error' });
        }
      }

      return res.status(201).json({ seat: result.seat });
    } catch (err) {
      logger.error({ err: err.message }, 'POST seat failed');
      return res.status(500).json({ error: 'Failed to book seat.' });
    }
  });

  // ─── Cancel a seat ────────────────────────────────────────────────────────
  router.delete('/sessions/:id/seats/:seatId', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const seatId = Number(req.params.seatId);
      if (!Number.isInteger(seatId) || seatId <= 0) {
        return res.status(400).json({ error: 'Invalid seat id.' });
      }
      const cancelledBy = (req.body && req.body.cancelled_by) || 'staff';

      const result = await cancelSeat({ tenantId, seatId, cancelledBy });
      if (!result.ok) {
        switch (result.code) {
          case 'seat_not_found':       return res.status(404).json({ error: result.code });
          case 'seat_already_cancelled': return res.status(409).json({ error: result.code });
          default: return res.status(400).json({ error: result.code || 'unknown_error' });
        }
      }
      return res.json({
        seat: result.seat,
        promoted: result.promoted,
        auto_promoted: Boolean(result.promoted),
      });
    } catch (err) {
      logger.error({ err: err.message }, 'DELETE seat failed');
      return res.status(500).json({ error: 'Failed to cancel seat.' });
    }
  });

  // ─── Check-in ─────────────────────────────────────────────────────────────
  router.post('/sessions/:id/seats/:seatId/check-in', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const seatId = Number(req.params.seatId);
      if (!Number.isInteger(seatId) || seatId <= 0) {
        return res.status(400).json({ error: 'Invalid seat id.' });
      }
      const staffId = req.body?.staff_id != null ? Number(req.body.staff_id) : null;

      const result = await checkIn({ tenantId, seatId, staffId });
      if (!result.ok) {
        return res.status(409).json({ error: result.code || 'unknown_error' });
      }
      return res.json({ seat: result.seat });
    } catch (err) {
      logger.error({ err: err.message }, 'check-in failed');
      return res.status(500).json({ error: 'Failed to check in.' });
    }
  });

  // ─── Join waitlist ────────────────────────────────────────────────────────
  router.post('/sessions/:id/waitlist', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const sessionId = Number(req.params.id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({ error: 'Invalid session id.' });
      }
      const customerId = Number(req.body?.customer_id);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        return res.status(400).json({ error: 'customer_id is required.' });
      }
      const result = await joinWaitlist({ tenantId, sessionId, customerId });
      if (!result.ok) {
        const code = result.code;
        if (code === 'session_not_found') return res.status(404).json({ error: code });
        return res.status(409).json({ error: code });
      }
      return res.status(201).json({ entry: result.entry });
    } catch (err) {
      logger.error({ err: err.message }, 'join waitlist failed');
      return res.status(500).json({ error: 'Failed to join waitlist.' });
    }
  });

  // ─── Leave waitlist ───────────────────────────────────────────────────────
  router.delete('/sessions/:id/waitlist/:wid', async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const wid = Number(req.params.wid);
      if (!Number.isInteger(wid) || wid <= 0) {
        return res.status(400).json({ error: 'Invalid waitlist id.' });
      }
      const r = await db.query(
        `UPDATE class_session_waitlist
         SET status = 'cancelled',
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND status = 'waiting'
         RETURNING *`,
        [wid, tenantId]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ error: 'waitlist_entry_not_found' });
      }
      return res.json({ entry: r.rows[0] });
    } catch (err) {
      logger.error({ err: err.message }, 'leave waitlist failed');
      return res.status(500).json({ error: 'Failed to leave waitlist.' });
    }
  });
};
