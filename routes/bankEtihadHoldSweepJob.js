'use strict';

// routes/bankEtihadHoldSweepJob.js
// PIECE 2c — Bank al Etihad pending-payment hold expiry sweep.
//
// What it does:
//   Cancels bookings whose 17-min BAE payment hold lapsed without a
//   /complete flip. A "BAE hold" is a booking sitting at
//   status='pending' + payment_status='pending' with
//   payment_hold_expires_at set in the past.
//
//   The WHERE guards mirror EXACTLY the guards used by the /complete flip
//   in routes/bankEtihadPayments.js (status='pending' AND
//   payment_status='pending'). That makes the sweep race-safe vs. a
//   completion firing at the same instant: whichever fires first wins,
//   and the loser's WHERE matches zero rows.
//
// Endpoint:
//   POST /api/jobs/bae-hold-sweep
//   Auth: ADMIN_API_KEY (requireAdmin) — same family as /api/jobs/trial-sweep.
//
// Schedule (operator setup):
//   Run every ~2 min via Render Cron or any external scheduler. The 17-min
//   hold tolerates that granularity easily. The query is one indexed
//   UPDATE (partial index idx_bookings_payment_hold_expiry from
//   migration 075) — fast and idempotent across runs.
//
//   Render Cron example:
//     curl -s -X POST https://<backend>/api/jobs/bae-hold-sweep \
//       -H "x-admin-key: $ADMIN_API_KEY"
//     Schedule: */2 * * * *
//
// This route is independent of the /complete flip path — even if no
// /complete ever fires, the sweep will release expired holds so the
// slots free up.

const express = require('express');
const router  = express.Router();

const db          = require('../db');
const logger      = require('../utils/logger');
const requireAdmin = require('../middleware/requireAdmin');

router.post('/bae-hold-sweep', requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    // cross-tenant sweep: admin-only job, intentionally no tenant filter.
    // Two coupled UPDATEs in one tx:
    //   (1) cancel expired held bookings, RETURNING their ids
    //   (2) expire the bank_etihad_payments rows linked to those bookings,
    //       guarded by AND status='pending' so any row that already raced to
    //       'completed' or 'failed' via /complete is left untouched.
    // The four booking guards (NOT NULL, < NOW(), status='pending',
    // payment_status='pending') make (1) race-safe vs. the /complete flip —
    // only one side can match a given row's current state. Wrapping (1)+(2)
    // in a tx keeps the booking-cancel and the payment-expire atomic, so we
    // never leave a cancelled booking paired with a still-'pending' payment
    // row that no later sweep would re-find (the booking is no longer
    // 'pending', so it wouldn't reappear in (1)'s set).
    await client.query('BEGIN');

    const swept = await client.query(`
      UPDATE bookings
         SET status = 'cancelled',
             updated_at = NOW()
       WHERE payment_hold_expires_at IS NOT NULL
         AND payment_hold_expires_at < NOW()
         AND status = 'pending'
         AND payment_status = 'pending'
       RETURNING id
    `);
    const expired       = swept.rowCount;
    const cancelledIds  = swept.rows.map((r) => r.id);

    let expiredPayments = 0;
    if (cancelledIds.length > 0) {
      const expireResult = await client.query(
        `UPDATE bank_etihad_payments
            SET status     = 'expired',
                updated_at = NOW()
          WHERE booking_id = ANY($1::int[])
            AND status     = 'pending'`,
        [cancelledIds]
      );
      expiredPayments = expireResult.rowCount;
    }

    await client.query('COMMIT');

    logger.info(
      { expired, expiredPayments },
      'BAE hold sweep: cancelled expired holds'
    );

    return res.json({
      ok: true,
      expired,
      expiredPayments,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow rollback noise */ }
    logger.error({ err: err.message }, 'BAE hold sweep failed');
    return res.status(500).json({ error: 'BAE hold sweep failed.' });
  } finally {
    client.release();
  }
});

module.exports = router;
