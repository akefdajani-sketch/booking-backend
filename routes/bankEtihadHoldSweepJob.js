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
  try {
    // cross-tenant sweep: admin-only job, intentionally no tenant filter
    // Single atomic UPDATE across all tenants. All four guards required:
    //   - payment_hold_expires_at IS NOT NULL  → only BAE-held bookings
    //   - payment_hold_expires_at < NOW()      → only expired ones
    //   - status = 'pending'                   → race-safe vs. /complete flip
    //   - payment_status = 'pending'           → race-safe vs. /complete flip
    const { rowCount } = await db.query(`
      UPDATE bookings
         SET status = 'cancelled',
             updated_at = NOW()
       WHERE payment_hold_expires_at IS NOT NULL
         AND payment_hold_expires_at < NOW()
         AND status = 'pending'
         AND payment_status = 'pending'
    `);

    logger.info({ expired: rowCount }, 'BAE hold sweep: cancelled expired holds');

    return res.json({
      ok: true,
      expired: rowCount,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'BAE hold sweep failed');
    return res.status(500).json({ error: 'BAE hold sweep failed.' });
  }
});

module.exports = router;
