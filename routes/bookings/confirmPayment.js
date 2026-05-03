// routes/bookings/confirmPayment.js
//
// CLIQ-CONFIRM-1: Operator endpoint to mark a booking's payment as received.
//
// Pre-existing payment_method column records the customer's INTENT (cliq,
// card, cash, …). Migration 064 introduced payment_status to track whether
// the money actually moved. Card payments flip to 'completed' automatically
// via the MPGS webhook in routes/networkPayments.js. CliQ and cash need
// manual confirmation — this endpoint is that interface.
//
// Endpoint:
//   POST /api/bookings/:id/confirm-payment
//
// Auth: tenant 'staff' role or higher. The acting user is recorded on the
// booking row (payment_confirmed_by_user_id) for audit.
//
// Body: { payment_reference?: string, notes?: string }
//   - payment_reference is optional but recommended for CliQ (bank ref number)
//   - notes is unused for now; reserved for a future booking_payment_log table
//
// Behavior:
//   - Only flips payment_status from 'pending' → 'completed'. Other states
//     (already completed, failed, refunded) are 409 Conflict — the operator
//     should not be able to "double-confirm" or reopen settled payments
//     through this endpoint.
//   - Bookings with payment_method IN ('membership','package','free') are
//     rejected: those are auto-settled, the endpoint isn't applicable.
//   - Returns the updated booking shape (same as crud GET /:id).
//
// Mounted by routes/bookings.js.

"use strict";

const db = require("../../db");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const { loadJoinedBookingById } = require("../../utils/bookings");
// VOICE-PERF-1: Bust customer cache on payment status change so the AI sees
// the new state on next turn (relevant if customer asks about their booking).
const aiContextCache = require("../../utils/aiContextCache");

const AUTO_SETTLED_METHODS = new Set(["membership", "package", "free"]);

module.exports = function mount(router) {
  router.post(
    "/:id/confirm-payment",
    requireAppAuth,
    requireTenant,
    requireAdminOrTenantRole("staff"),
    async (req, res) => {
      const client = await db.pool.connect();
      try {
        const tenantId  = Number(req.tenantId);
        const bookingId = Number(req.params.id);
        const userId    = Number(req.user?.id) || null;

        if (!Number.isFinite(bookingId) || bookingId <= 0) {
          return res.status(400).json({ error: "Invalid booking id." });
        }

        const reference = req.body?.payment_reference != null
          ? String(req.body.payment_reference).trim().slice(0, 200) || null
          : null;

        await client.query("BEGIN");

        // Lock the row so two concurrent operator confirmations can't both
        // succeed and produce confusing duplicate audit timestamps.
        const cur = await client.query(
          `SELECT id, payment_method, payment_status
             FROM bookings
            WHERE id        = $1
              AND tenant_id = $2
              AND deleted_at IS NULL
            FOR UPDATE`,
          [bookingId, tenantId]
        );

        if (!cur.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Booking not found." });
        }

        const { payment_method, payment_status } = cur.rows[0];

        // Reject auto-settled methods — there is no money to confirm here.
        if (AUTO_SETTLED_METHODS.has(payment_method)) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Cannot manually confirm '${payment_method}' bookings — these settle automatically at booking time.`,
            code:  "AUTO_SETTLED_METHOD",
          });
        }

        // Reject bookings without a method declared (the historical NULL set).
        if (payment_method == null) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "This booking has no payment_method set. Edit the booking to set a method first.",
            code:  "NO_PAYMENT_METHOD",
          });
        }

        // Idempotency-style guard: only flip from pending. Already-completed
        // bookings return 409 (not 200) so the caller knows the click did
        // nothing — UI should refresh from server state.
        if (payment_status !== "pending") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Booking payment is already in '${payment_status || 'unknown'}' state.`,
            code:  "NOT_PENDING",
            current_status: payment_status,
          });
        }

        await client.query(
          `UPDATE bookings
              SET payment_status                = 'completed',
                  payment_confirmed_by_user_id  = $2,
                  payment_confirmed_at          = NOW(),
                  payment_reference             = $3,
                  updated_at                    = NOW()
            WHERE id = $1`,
          [bookingId, userId, reference]
        );

        await client.query("COMMIT");

        // Bust customer cache (AI may quote payment status to the customer
        // on a follow-up question like "is my booking paid up?").
        try {
          aiContextCache.bustCustomer(tenantId);
        } catch (_) { /* never block response on cache hygiene */ }

        const joined = await loadJoinedBookingById(bookingId, tenantId);
        return res.json({
          booking: joined,
          confirmed: true,
        });
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        console.error("[bookings/confirmPayment] error:", err);
        return res.status(500).json({ error: "Failed to confirm payment." });
      } finally {
        client.release();
      }
    }
  );
};
