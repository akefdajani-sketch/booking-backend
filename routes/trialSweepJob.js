'use strict';

// routes/trialSweepJob.js
// PR F (Trial lifecycle hardening).
//
// Defensive sync: handle the case where Stripe failed to deliver
// customer.subscription.updated when a trial transitions to active (or to
// past_due / canceled). The webhook is the primary path; this job is the
// belt-and-suspenders backup.
//
// What it does:
//   1. Find tenants where local status = 'trialing' AND trial_ends_at < NOW()
//      → these should have transitioned by now.
//   2. For each, ask Stripe directly what the subscription's current status is.
//   3. If Stripe says 'active' → call syncSubscriptionStatus(tenantId, 'active').
//      If Stripe says 'past_due' → mark past_due.
//      If Stripe says 'canceled' → mark canceled.
//      If Stripe says still 'trialing' (e.g. trial extended) → leave alone.
//   4. Return a summary of {checked, transitioned, skipped, errors}.
//
// Endpoint:
//   POST /api/jobs/trial-sweep
//   Auth: ADMIN_API_KEY (so it can be triggered by Render Cron, an external
//         scheduler, or ak's terminal — not by tenant users).
//
// Schedule (operator setup):
//   Run hourly via Render Cron or any external scheduler. The job is fast
//   (<1s for typical tenant counts) and idempotent.
//
// This route is independent of the webhook handler — even if all webhooks
// stopped working tomorrow, the trial sweep would catch transitions.

const express = require('express');
const router  = express.Router();

const db          = require('../db');
const logger      = require('../utils/logger');
const requireAdmin = require('../middleware/requireAdmin');
const { getStripe, isStripeEnabled } = require('../utils/stripe');

// Reuse the same status-sync helper the webhook uses. Re-exported here for
// isolation from the webhook file.
async function syncSubscriptionStatus(tenantId, status) {
  if (!tenantId || !status) return;
  await db.query(
    `UPDATE tenant_subscriptions
        SET status = $1
      WHERE tenant_id = $2
        AND id = (
          SELECT id FROM tenant_subscriptions
           WHERE tenant_id = $2
           ORDER BY COALESCE(started_at, NOW()) DESC
           LIMIT 1
        )`,
    [status, tenantId]
  );
}

router.post('/trial-sweep', requireAdmin, async (req, res) => {
  if (!isStripeEnabled()) {
    return res.status(503).json({ error: 'Billing not configured on this server.' });
  }
  const stripe = getStripe();
  const summary = { checked: 0, transitioned: 0, skipped: 0, errors: 0, details: [] };

  try {
    // Find local subs that LOOK like they should have transitioned by now.
    // We also include trials in the next 24h as a soft check window — Stripe
    // sometimes flips status slightly before the local trial_ends_at.
    const { rows } = await db.query(`
      SELECT ts.id AS subscription_id,
             ts.tenant_id,
             ts.status,
             ts.trial_ends_at,
             t.slug,
             t.stripe_subscription_id
      FROM tenant_subscriptions ts
      JOIN tenants t ON t.id = ts.tenant_id
      WHERE ts.status = 'trialing'
        AND ts.trial_ends_at IS NOT NULL
        AND ts.trial_ends_at < NOW() + INTERVAL '1 day'
      ORDER BY ts.trial_ends_at ASC
      LIMIT 200
    `);

    summary.checked = rows.length;

    for (const row of rows) {
      try {
        if (!row.stripe_subscription_id) {
          summary.skipped++;
          summary.details.push({
            tenantId: row.tenant_id,
            slug: row.slug,
            reason: 'no_stripe_subscription_id',
          });
          continue;
        }

        // Single Stripe call per tenant — bounded list (LIMIT 200 above).
        const stripeSub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
        const remoteStatus = stripeSub?.status;

        if (!remoteStatus) {
          summary.skipped++;
          summary.details.push({ tenantId: row.tenant_id, slug: row.slug, reason: 'no_remote_status' });
          continue;
        }

        if (remoteStatus === 'trialing') {
          // Stripe still says trialing — maybe trial was extended. Leave alone.
          summary.skipped++;
          continue;
        }

        if (remoteStatus !== row.status) {
          await syncSubscriptionStatus(row.tenant_id, remoteStatus);
          summary.transitioned++;
          summary.details.push({
            tenantId: row.tenant_id,
            slug: row.slug,
            from: row.status,
            to: remoteStatus,
          });
          logger.info(
            { tenantId: row.tenant_id, from: row.status, to: remoteStatus },
            'Trial sweep: subscription status transitioned'
          );
        } else {
          summary.skipped++;
        }
      } catch (perTenantErr) {
        summary.errors++;
        summary.details.push({
          tenantId: row.tenant_id,
          slug: row.slug,
          error: perTenantErr?.message || 'unknown',
        });
        logger.warn(
          { err: perTenantErr.message, tenantId: row.tenant_id, slug: row.slug },
          'Trial sweep: per-tenant error (continuing)'
        );
      }
    }

    return res.json({ ok: true, ...summary, ranAt: new Date().toISOString() });
  } catch (err) {
    logger.error({ err: err.message }, 'Trial sweep failed');
    return res.status(500).json({ error: 'Trial sweep failed.' });
  }
});

module.exports = router;
