'use strict';

// routes/stripeWebhook.js
// PR-4: Stripe Billing Wiring — Webhook handler
//
// Endpoint:
//   POST /api/billing/webhook
//
// This route MUST be mounted BEFORE express.json() because Stripe requires
// the raw request body for signature verification.
//
// Handled events:
//   checkout.session.completed     — activate subscription after payment
//   customer.subscription.updated  — sync status changes (upgrade/downgrade)
//   customer.subscription.deleted  — mark subscription as canceled
//   invoice.payment_failed         — mark as past_due
//
// Env vars:
//   STRIPE_WEBHOOK_SECRET — from Stripe dashboard → Webhooks → Signing secret

const express = require('express');
const router  = express.Router();

const db     = require('../db');
const logger = require('../utils/logger');
const { getStripe, isStripeEnabled } = require('../utils/stripe');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getTenantIdByCustomer(customerId) {
  const r = await db.query(
    `SELECT id FROM tenants WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId]
  );
  return r.rows[0]?.id || null;
}

async function syncSubscriptionStatus(tenantId, status) {
  if (!tenantId) return;
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

async function activateSubscription(tenantId, planCode, stripeSubscriptionId) {
  if (!tenantId) return;

  // Resolve plan id from plan_code
  const planRow = await db.query(
    `SELECT id FROM saas_plans WHERE code = $1 LIMIT 1`,
    [planCode]
  );
  const planId = planRow.rows[0]?.id;
  if (!planId) {
    logger.warn({ planCode }, 'activateSubscription: unknown plan code');
    return;
  }

  // Upsert subscription: update existing trialing row or insert new active row
  await db.query(
    `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, started_at)
     VALUES ($1, $2, 'active', NOW())
     ON CONFLICT DO NOTHING`,
    [tenantId, planId]
  );

  // Ensure the most recent row for this tenant is now active
  await db.query(
    `UPDATE tenant_subscriptions
        SET status = 'active', plan_id = $2
      WHERE tenant_id = $1
        AND id = (
          SELECT id FROM tenant_subscriptions
           WHERE tenant_id = $1
           ORDER BY COALESCE(started_at, NOW()) DESC
           LIMIT 1
        )`,
    [tenantId, planId]
  );

  logger.info({ tenantId, planCode, stripeSubscriptionId }, 'Subscription activated');
}

// ─── Route ───────────────────────────────────────────────────────────────────

// express.raw() to keep body as Buffer for Stripe signature verification
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!isStripeEnabled()) {
      return res.status(503).json({ error: 'Billing not configured.' });
    }

    const stripe = getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
      logger.warn('STRIPE_WEBHOOK_SECRET not set — webhook signature verification skipped (dev mode)');
    }

    let event;
    try {
      if (secret) {
        const sig = req.headers['stripe-signature'];
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
      } else {
        // Dev/test: parse raw body manually
        event = JSON.parse(req.body.toString());
      }
    } catch (err) {
      logger.warn({ err }, 'Stripe webhook signature verification failed');
      return res.status(400).json({ error: 'Webhook signature invalid.' });
    }

    logger.info({ type: event.type, id: event.id }, 'Stripe webhook received');

    try {
      switch (event.type) {

        case 'checkout.session.completed': {
          const session = event.data.object;
          if (session.mode !== 'subscription') break;

          const customerId = session.customer;
          const planCode   = session.metadata?.plan_code;
          const subId      = session.subscription;
          const tenantId   = await getTenantIdByCustomer(customerId);

          if (!tenantId) {
            logger.warn({ customerId }, 'checkout.session.completed: tenant not found for customer');
            break;
          }

          await activateSubscription(tenantId, planCode, subId);
          break;
        }

        case 'customer.subscription.updated': {
          const sub        = event.data.object;
          const customerId = sub.customer;
          const status     = sub.status; // active | past_due | canceled | trialing | paused
          const tenantId   = await getTenantIdByCustomer(customerId);
          await syncSubscriptionStatus(tenantId, status);
          logger.info({ tenantId, status }, 'Subscription status synced');
          break;
        }

        case 'customer.subscription.deleted': {
          const sub        = event.data.object;
          const customerId = sub.customer;
          const tenantId   = await getTenantIdByCustomer(customerId);
          await syncSubscriptionStatus(tenantId, 'canceled');
          logger.info({ tenantId }, 'Subscription canceled');
          break;
        }

        case 'invoice.payment_failed': {
          const invoice    = event.data.object;
          const customerId = invoice.customer;
          const tenantId   = await getTenantIdByCustomer(customerId);
          await syncSubscriptionStatus(tenantId, 'past_due');
          logger.warn({ tenantId }, 'Subscription payment failed — marked past_due');
          break;
        }

        default:
          logger.info({ type: event.type }, 'Unhandled Stripe webhook event (ignored)');
      }
    } catch (err) {
      logger.error({ err, eventType: event.type }, 'Error processing Stripe webhook');
      // Return 200 to prevent Stripe retrying — we log and investigate separately
    }

    return res.json({ received: true });
  }
);

module.exports = router;
