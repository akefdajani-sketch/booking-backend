'use strict';

// routes/stripeWebhook.js
// PR-4: Stripe Billing Wiring — Webhook handler
// PR-9: Invoice + Payment Record Creation
// G2a-2: Route contract invoice.* events to contract_invoices via metadata.flexrz_channel
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
//   invoice.paid                   — record invoice + payment in DB (PR-9) OR
//                                    mark contract_invoices.paid (G2a-2)
//   invoice.payment_failed         — record failed invoice + mark past_due (PR-9) OR
//                                    append audit note to contract_invoices (G2a-2)
//   invoice.voided                 — mark contract_invoices.void (G2a-2)
//
// Env vars:
//   STRIPE_WEBHOOK_SECRET — from Stripe dashboard → Webhooks → Signing secret

const express = require('express');
const router  = express.Router();

const db     = require('../db');
const logger = require('../utils/logger');
const { getStripe, isStripeEnabled } = require('../utils/stripe');
const { handleContractInvoiceEvent } = require('../utils/contractWebhookHandler'); // G2a-2

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

  const planRow = await db.query(
    `SELECT id FROM saas_plans WHERE code = $1 LIMIT 1`,
    [planCode]
  );
  const planId = planRow.rows[0]?.id;
  if (!planId) {
    logger.warn({ planCode }, 'activateSubscription: unknown plan code');
    return;
  }

  await db.query(
    `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, started_at)
     VALUES ($1, $2, 'active', NOW())
     ON CONFLICT DO NOTHING`,
    [tenantId, planId]
  );

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

// ─── PR-9: Invoice + Payment helpers ─────────────────────────────────────────

/**
 * Upsert a tenant_invoices row from a Stripe invoice object.
 * Uses stripe_invoice_id as the idempotency key so replaying a webhook
 * never creates duplicate rows.
 *
 * Returns the tenant_invoices.id for the row.
 */
async function upsertInvoice(tenantId, stripeInvoice, status) {
  const stripeInvoiceId  = stripeInvoice.id;
  const amountCents      = stripeInvoice.amount_paid ?? stripeInvoice.amount_due ?? 0;
  const currency         = (stripeInvoice.currency || 'usd').toLowerCase();
  const paidAt           = status === 'paid'
    ? new Date(stripeInvoice.status_transitions?.paid_at * 1000 || Date.now())
    : null;

  // Resolve subscription FK — may be null for one-off invoices
  let subscriptionId = null;
  if (stripeInvoice.subscription) {
    const subRow = await db.query(
      `SELECT id FROM tenant_subscriptions
        WHERE tenant_id = $1
        ORDER BY COALESCE(started_at, NOW()) DESC
        LIMIT 1`,
      [tenantId]
    );
    subscriptionId = subRow.rows[0]?.id ?? null;
  }

  const result = await db.query(
    `INSERT INTO tenant_invoices
       (tenant_id, subscription_id, stripe_invoice_id, amount_cents, currency, status, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (stripe_invoice_id)
       DO UPDATE SET
         status  = EXCLUDED.status,
         paid_at = COALESCE(EXCLUDED.paid_at, tenant_invoices.paid_at)
     RETURNING id`,
    [tenantId, subscriptionId, stripeInvoiceId, amountCents, currency, status, paidAt]
  );

  return result.rows[0]?.id;
}

/**
 * Insert a tenant_payments row for a successfully paid invoice.
 * Idempotent: skips if a payment row for this provider_payment_intent_id
 * already exists.
 */
async function recordPayment(tenantId, invoiceId, stripeInvoice) {
  const paymentIntentId = stripeInvoice.payment_intent || null;
  const chargeId        = stripeInvoice.charge || null;
  const amountCents     = stripeInvoice.amount_paid ?? 0;
  const currency        = (stripeInvoice.currency || 'usd').toLowerCase();

  await db.query(
    `INSERT INTO tenant_payments
       (tenant_id, invoice_id, status, amount_cents, currency,
        provider_payment_intent_id, provider_charge_id)
     VALUES ($1, $2, 'succeeded', $3, $4, $5, $6)
     ON CONFLICT (provider_payment_intent_id)
       DO NOTHING`,
    [tenantId, invoiceId, amountCents, currency, paymentIntentId, chargeId]
  );
}

// ─── Route ───────────────────────────────────────────────────────────────────

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
          const session    = event.data.object;
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
          const status     = sub.status;
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

        // ── F: Trial ending soon — Stripe fires this 3 days before trial_ends_at ──
        // Set trial_warning_sent_at on the local subscription row (dedup
        // guard + audit trail). Also surfaces as an Owner Dashboard signal
        // through the new "Trials ending" KPI in E, and the Trials Ending
        // badge on the Tenants list in F.
        case 'customer.subscription.trial_will_end': {
          const sub        = event.data.object;
          const customerId = sub.customer;
          const tenantId   = await getTenantIdByCustomer(customerId);
          if (!tenantId) {
            logger.warn({ customerId }, 'trial_will_end: tenant not found for customer');
            break;
          }
          // Touch only the most-recent subscription row (mirrors syncSubscriptionStatus).
          await db.query(
            `UPDATE tenant_subscriptions
                SET trial_warning_sent_at = COALESCE(trial_warning_sent_at, NOW())
              WHERE id = (
                SELECT id FROM tenant_subscriptions
                 WHERE tenant_id = $1
                 ORDER BY COALESCE(started_at, NOW()) DESC
                 LIMIT 1
              )`,
            [tenantId]
          );
          logger.info(
            { tenantId, trialEndsAt: sub.trial_end },
            'Trial ending soon — warning timestamp recorded'
          );
          break;
        }

        // ── PR-9: Invoice paid ───────────────────────────────────────────────
        case 'invoice.paid': {
          const stripeInvoice = event.data.object;

          // G2a-2: If this is a contract invoice (metadata.flexrz_channel==='contract'),
          // route to contract_invoices handler and skip tenant_invoices path.
          const handled = await handleContractInvoiceEvent('invoice.paid', stripeInvoice);
          if (handled) break;

          const customerId    = stripeInvoice.customer;
          const tenantId      = await getTenantIdByCustomer(customerId);

          if (!tenantId) {
            logger.warn({ customerId }, 'invoice.paid: tenant not found for customer');
            break;
          }

          // 1. Upsert the invoice record
          const invoiceId = await upsertInvoice(tenantId, stripeInvoice, 'paid');

          // 2. Record the payment
          if (invoiceId) {
            await recordPayment(tenantId, invoiceId, stripeInvoice);
          }

          logger.info(
            { tenantId, stripeInvoiceId: stripeInvoice.id, invoiceId },
            'Invoice paid — record created'
          );
          break;
        }

        // ── PR-9: Invoice payment failed ─────────────────────────────────────
        case 'invoice.payment_failed': {
          const stripeInvoice = event.data.object;

          // G2a-2: Route to contract handler if this is a contract invoice
          const handled = await handleContractInvoiceEvent('invoice.payment_failed', stripeInvoice);
          if (handled) break;

          const customerId    = stripeInvoice.customer;
          const tenantId      = await getTenantIdByCustomer(customerId);

          if (!tenantId) {
            logger.warn({ customerId }, 'invoice.payment_failed: tenant not found for customer');
            break;
          }

          // Record the failed invoice
          const invoiceId = await upsertInvoice(tenantId, stripeInvoice, 'failed');

          // Record the failed payment attempt
          if (invoiceId) {
            const paymentIntentId = stripeInvoice.payment_intent || null;
            const failureReason   = stripeInvoice.last_finalization_error?.message
              || 'Payment failed';

            await db.query(
              `INSERT INTO tenant_payments
                 (tenant_id, invoice_id, status, amount_cents, currency,
                  provider_payment_intent_id, failure_reason)
               VALUES ($1, $2, 'failed', $3, $4, $5, $6)
               ON CONFLICT (provider_payment_intent_id)
                 DO NOTHING`,
              [
                tenantId,
                invoiceId,
                stripeInvoice.amount_due ?? 0,
                (stripeInvoice.currency || 'usd').toLowerCase(),
                paymentIntentId,
                failureReason,
              ]
            );
          }

          // Mark subscription as past_due
          await syncSubscriptionStatus(tenantId, 'past_due');
          logger.warn({ tenantId }, 'Subscription payment failed — marked past_due');
          break;
        }

        // ── G2a-2: Invoice voided (contract invoice cancellation) ────────────
        case 'invoice.voided': {
          const stripeInvoice = event.data.object;
          const handled = await handleContractInvoiceEvent('invoice.voided', stripeInvoice);
          if (!handled) {
            logger.info({ stripeInvoiceId: stripeInvoice.id },
                        'invoice.voided: not a contract channel invoice, no tenant_invoices handler');
          }
          break;
        }

        // ── G2a-2: Invoice finalized / sent (informational for contracts) ────
        case 'invoice.finalized':
        case 'invoice.sent': {
          const stripeInvoice = event.data.object;
          await handleContractInvoiceEvent(event.type, stripeInvoice);
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
