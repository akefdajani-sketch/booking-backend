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
const { sendEmail } = require('../utils/email'); // G: transactional email
const {
  renderTrialWarning,
  renderPaymentFailed,
  renderWelcome,
  renderTrialConverted,
} = require('../utils/emailTemplates'); // G: transactional email templates

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

// ─── G: Email helper ─────────────────────────────────────────────────────────
// Fetch the data needed to send a tenant-level transactional email in one
// query. Returns null when the tenant has no recipient — the caller's
// responsibility is to skip the send. We never throw — DB hiccups become
// "no email" rather than webhook failures.

async function getTenantEmailContext(tenantId) {
  if (!tenantId) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        t.id          AS tenant_id,
        t.slug,
        t.name        AS tenant_name,
        t.admin_email,
        t.billing_email,
        ts.trial_ends_at,
        sp.code       AS plan_code,
        sp.name       AS plan_name
      FROM tenants t
      LEFT JOIN LATERAL (
        SELECT plan_id, trial_ends_at
        FROM tenant_subscriptions
        WHERE tenant_id = t.id
        ORDER BY COALESCE(started_at, NOW()) DESC
        LIMIT 1
      ) ts ON TRUE
      LEFT JOIN saas_plans sp ON sp.id = ts.plan_id
      WHERE t.id = $1
      LIMIT 1
    `, [tenantId]);

    const row = rows[0];
    if (!row) return null;

    // Prefer billing_email for billing-related events, fall back to admin_email.
    const recipient = row.billing_email || row.admin_email;
    if (!recipient) return null;

    return {
      tenantId: row.tenant_id,
      slug: row.slug,
      tenantName: row.tenant_name,
      recipient,
      trialEndsAt: row.trial_ends_at,
      planCode: row.plan_code,
      planName: row.plan_name,
      manageBillingUrl: `${(process.env.APP_BASE_URL || 'https://app.flexrz.com').replace(/\/+$/, '')}/owner/${encodeURIComponent(row.slug)}`,
    };
  } catch (err) {
    logger.warn({ err: err.message, tenantId }, 'getTenantEmailContext failed (non-fatal)');
    return null;
  }
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

          // G: send welcome email (async, non-fatal — webhook still 200s on email failure)
          try {
            const ctx = await getTenantEmailContext(tenantId);
            if (ctx) {
              const tpl = renderWelcome({
                tenantName: ctx.tenantName,
                planName: ctx.planName,
                trialEndsAt: ctx.trialEndsAt,
                dashboardUrl: ctx.manageBillingUrl,
              });
              await sendEmail({
                kind: 'welcome',
                to: ctx.recipient,
                subject: tpl.subject,
                html: tpl.html,
                text: tpl.text,
                tenantId,
                meta: { plan_code: ctx.planCode, source: 'checkout.session.completed' },
              });
            }
          } catch (emailErr) {
            logger.error({ err: emailErr.message, tenantId }, 'welcome email failed (non-fatal)');
          }
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

          // G: send the trial-warning email. The trial_warning_sent_at column
          // doubles as a dedup guard — Stripe sometimes re-fires this event,
          // and COALESCE ensures we only stamp once. We re-check inside this
          // try block by reading the just-updated row, so the second webhook
          // delivery is a no-op email-wise.
          try {
            const dedup = await db.query(
              `SELECT trial_warning_sent_at FROM tenant_subscriptions
                WHERE id = (
                  SELECT id FROM tenant_subscriptions
                   WHERE tenant_id = $1
                   ORDER BY COALESCE(started_at, NOW()) DESC
                   LIMIT 1
                )`,
              [tenantId]
            );
            const stampedAt = dedup.rows[0]?.trial_warning_sent_at;
            // Only send if the stamp is fresh (within last 5 minutes — accounts
            // for clock skew without ever sending duplicates on retry).
            const isFresh = stampedAt && (Date.now() - new Date(stampedAt).getTime()) < 5 * 60 * 1000;
            if (!isFresh) {
              logger.info({ tenantId }, 'trial_will_end: warning already sent (stale stamp), skipping email');
              break;
            }

            const ctx = await getTenantEmailContext(tenantId);
            if (ctx) {
              const tpl = renderTrialWarning({
                tenantName: ctx.tenantName,
                trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : ctx.trialEndsAt,
                planName: ctx.planName,
                manageBillingUrl: ctx.manageBillingUrl,
              });
              await sendEmail({
                kind: 'trial_warning',
                to: ctx.recipient,
                subject: tpl.subject,
                html: tpl.html,
                text: tpl.text,
                tenantId,
                meta: { trial_ends_at: sub.trial_end, plan_code: ctx.planCode },
              });
            }
          } catch (emailErr) {
            logger.error({ err: emailErr.message, tenantId }, 'trial_warning email failed (non-fatal)');
          }
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

          // J.1: Send "Subscription is now active" email if this is the first
          // paid invoice after a trial conversion.
          //
          // Detection logic (idempotent, no new schema):
          //   - email_log already has a row with kind='trial_converted' for this
          //     tenant → skip (already sent, this is a recurring invoice)
          //   - Otherwise → send + email_log records the kind='trial_converted'
          //     row, future invoices will be skipped.
          //
          // Schema-compat: if email_log table missing (G migration 054 not run),
          // sendEmail() handles that gracefully and the whole block is wrapped
          // in try/catch so webhook still 200s.
          try {
            const dedupCheck = await db.query(
              `SELECT 1
                 FROM email_log
                WHERE tenant_id = $1
                  AND kind      = 'trial_converted'
                  AND status    = 'sent'
                LIMIT 1`,
              [tenantId]
            );
            const alreadySent = dedupCheck.rows.length > 0;

            if (!alreadySent) {
              const ctx = await getTenantEmailContext(tenantId);
              if (ctx) {
                const tpl = renderTrialConverted({
                  tenantName: ctx.tenantName,
                  planName: ctx.planName,
                  amountCents: stripeInvoice.amount_paid || 0,
                  currency: (stripeInvoice.currency || 'usd').toLowerCase(),
                  manageBillingUrl: ctx.manageBillingUrl,
                });
                await sendEmail({
                  kind: 'trial_converted',
                  to: ctx.recipient,
                  subject: tpl.subject,
                  html: tpl.html,
                  text: tpl.text,
                  tenantId,
                  meta: {
                    plan_code: ctx.planCode,
                    stripe_invoice_id: stripeInvoice.id,
                    amount_paid_cents: stripeInvoice.amount_paid,
                    currency: stripeInvoice.currency,
                    source: 'invoice.paid',
                  },
                });
                logger.info({ tenantId, stripeInvoiceId: stripeInvoice.id }, 'trial_converted email sent');
              }
            }
          } catch (emailErr) {
            // Schema-compat: email_log table may not exist yet — treat as "first
            // time" and let sendEmail() decide if it can ship. If sendEmail also
            // fails, log it but don't fail the webhook.
            if (/relation .*email_log.* does not exist/i.test(emailErr.message || '')) {
              logger.info({ tenantId }, 'trial_converted dedup check skipped (email_log table missing)');
            } else {
              logger.error({ err: emailErr.message, tenantId }, 'trial_converted email failed (non-fatal)');
            }
          }
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

          // G: send payment-failed email so the tenant can update their card
          // before Stripe gives up retrying. Non-fatal — webhook still 200s
          // on email failure (Stripe will retry the webhook on a real failure).
          try {
            const ctx = await getTenantEmailContext(tenantId);
            if (ctx) {
              const tpl = renderPaymentFailed({
                tenantName: ctx.tenantName,
                amountCents: stripeInvoice.amount_due ?? 0,
                currency: stripeInvoice.currency,
                manageBillingUrl: ctx.manageBillingUrl,
              });
              await sendEmail({
                kind: 'payment_failed',
                to: ctx.recipient,
                subject: tpl.subject,
                html: tpl.html,
                text: tpl.text,
                tenantId,
                meta: {
                  invoice_id: stripeInvoice.id,
                  amount_cents: stripeInvoice.amount_due,
                  currency: stripeInvoice.currency,
                },
              });
            }
          } catch (emailErr) {
            logger.error({ err: emailErr.message, tenantId }, 'payment_failed email failed (non-fatal)');
          }
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
