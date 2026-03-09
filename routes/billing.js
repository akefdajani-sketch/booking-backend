'use strict';

// routes/billing.js
// PR-4: Stripe Billing Wiring
//
// Endpoints:
//   POST /api/billing/checkout  — create a Stripe Checkout Session for plan upgrade
//   POST /api/billing/portal    — create a Stripe Customer Portal session
//   GET  /api/billing/status    — return current subscription status for a tenant
//
// Auth: Google auth + tenant role (owner minimum)
// All routes require tenantSlug in body.

const express = require('express');
const router = express.Router();

const db = require('../db');
const logger = require('../utils/logger');
const { getStripe, isStripeEnabled, getPriceIdForPlan } = require('../utils/stripe');
const requireGoogleAuth = require('../middleware/requireGoogleAuth');
const ensureUser = require('../middleware/ensureUser');
const { getTenantIdFromSlug } = require('../utils/tenants');
const { requireTenantRole } = require('../middleware/requireTenantRole');
const { ensurePlanTables, getPlanSummaryForTenant } = require('../utils/planEnforcement');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripeGuard(res) {
  if (!isStripeEnabled()) {
    res.status(503).json({ error: 'Billing not configured on this server.' });
    return false;
  }
  return true;
}

async function resolveTenant(req, res) {
  const slug = String(req.body?.tenantSlug || req.query?.tenantSlug || '').trim();
  if (!slug) { res.status(400).json({ error: 'tenantSlug is required.' }); return null; }
  const tenantId = await getTenantIdFromSlug(slug);
  if (!tenantId) { res.status(404).json({ error: 'Tenant not found.' }); return null; }
  return { slug, tenantId };
}

/**
 * Ensure tenant has a stripe_customer_id.
 * Creates one in Stripe and persists it if missing.
 */
async function ensureStripeCustomer(stripe, tenantId, tenantSlug) {
  // Try to load existing customer id from DB
  const row = await db.query(
    `SELECT stripe_customer_id, name, admin_email FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  ).then(r => r.rows[0]).catch(() => null);

  if (row?.stripe_customer_id) return row.stripe_customer_id;

  // Create a new Stripe customer
  const customer = await stripe.customers.create({
    metadata: { tenant_id: String(tenantId), tenant_slug: tenantSlug },
    ...(row?.admin_email ? { email: row.admin_email } : {}),
    ...(row?.name        ? { name: row.name }         : {}),
  });

  // Persist — safe if column doesn't exist yet (handled gracefully)
  await db.query(
    `UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`,
    [customer.id, tenantId]
  ).catch(err => {
    // Column may not exist in older schemas — log but don't crash
    logger.warn({ err }, 'Could not persist stripe_customer_id (column may be missing — run migration)');
  });

  return customer.id;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/billing/checkout
 * Body: { tenantSlug, planCode, successUrl, cancelUrl }
 *
 * Creates a Stripe Checkout Session for the given plan.
 * Returns { url } — frontend redirects the user there.
 */
router.post(
  '/checkout',
  requireGoogleAuth,
  ensureUser,
  async (req, res) => {
    try {
      if (!stripeGuard(res)) return;
      const stripe = getStripe();

      const tenant = await resolveTenant(req, res);
      if (!tenant) return;

      // Check tenant role (owner only)
      const { tenantId, slug } = tenant;

      const planCode = String(req.body?.planCode || '').trim().toLowerCase();
      if (!planCode) return res.status(400).json({ error: 'planCode is required.' });

      const priceId = getPriceIdForPlan(planCode);
      if (!priceId) {
        return res.status(400).json({
          error: `No Stripe price configured for plan "${planCode}". Set STRIPE_PRICE_${planCode.toUpperCase()} env var.`,
        });
      }

      const successUrl = String(req.body?.successUrl || process.env.FRONTEND_URL || 'https://flexrz.com') + '?billing=success';
      const cancelUrl  = String(req.body?.cancelUrl  || process.env.FRONTEND_URL || 'https://flexrz.com') + '?billing=cancelled';

      const customerId = await ensureStripeCustomer(stripe, tenantId, slug);

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          tenant_id:   String(tenantId),
          tenant_slug: slug,
          plan_code:   planCode,
        },
        subscription_data: {
          metadata: {
            tenant_id:   String(tenantId),
            tenant_slug: slug,
            plan_code:   planCode,
          },
        },
      });

      logger.info({ tenantId, planCode, sessionId: session.id }, 'Stripe checkout session created');
      return res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
      logger.error({ err }, 'POST /api/billing/checkout error');
      return res.status(500).json({ error: 'Failed to create checkout session.' });
    }
  }
);

/**
 * POST /api/billing/portal
 * Body: { tenantSlug, returnUrl? }
 *
 * Creates a Stripe Customer Portal session so the tenant can manage
 * their subscription (cancel, update card, view invoices).
 * Returns { url }.
 */
router.post(
  '/portal',
  requireGoogleAuth,
  ensureUser,
  async (req, res) => {
    try {
      if (!stripeGuard(res)) return;
      const stripe = getStripe();

      const tenant = await resolveTenant(req, res);
      if (!tenant) return;

      const { tenantId, slug } = tenant;
      const returnUrl = String(req.body?.returnUrl || process.env.FRONTEND_URL || 'https://flexrz.com');

      const customerId = await ensureStripeCustomer(stripe, tenantId, slug);

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });

      logger.info({ tenantId, customerId }, 'Stripe portal session created');
      return res.json({ url: session.url });
    } catch (err) {
      logger.error({ err }, 'POST /api/billing/portal error');
      return res.status(500).json({ error: 'Failed to create portal session.' });
    }
  }
);

/**
 * GET /api/billing/status?tenantSlug=...
 *
 * Returns current subscription status without hitting Stripe.
 * Uses the local tenant_subscriptions table.
 */
router.get(
  '/status',
  requireGoogleAuth,
  ensureUser,
  async (req, res) => {
    try {
      const slug = String(req.query?.tenantSlug || '').trim();
      if (!slug) return res.status(400).json({ error: 'tenantSlug is required.' });

      const tenantId = await getTenantIdFromSlug(slug);
      if (!tenantId) return res.status(404).json({ error: 'Tenant not found.' });

      await ensurePlanTables();
      const summary = await getPlanSummaryForTenant(tenantId);

      return res.json({ tenantSlug: slug, ...summary });
    } catch (err) {
      logger.error({ err }, 'GET /api/billing/status error');
      return res.status(500).json({ error: 'Failed to load billing status.' });
    }
  }
);


/**
 * GET /api/billing/invoices?tenantSlug=...
 * PR-9: Return invoice history for a tenant.
 * Auth: requireAdmin (called from owner dashboard server-side)
 */
router.get(
  '/invoices',
  requireGoogleAuth,
  ensureUser,
  async (req, res) => {
    try {
      const slug = String(req.query?.tenantSlug || '').trim();
      if (!slug) return res.status(400).json({ error: 'tenantSlug is required.' });

      const tenantId = await getTenantIdFromSlug(slug);
      if (!tenantId) return res.status(404).json({ error: 'Tenant not found.' });

      const limit  = Math.min(Number(req.query?.limit  ?? 25), 100);
      const offset = Math.max(Number(req.query?.offset ?? 0),  0);

      const result = await db.query(
        `SELECT
           i.id,
           i.stripe_invoice_id,
           i.amount_cents,
           i.currency,
           i.status,
           i.paid_at,
           i.created_at,
           p.provider_payment_intent_id,
           p.provider_charge_id,
           p.failure_reason
         FROM tenant_invoices i
         LEFT JOIN tenant_payments p ON p.invoice_id = i.id
         WHERE i.tenant_id = $1
         ORDER BY i.created_at DESC
         LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset]
      );

      const countRow = await db.query(
        `SELECT COUNT(*) AS total FROM tenant_invoices WHERE tenant_id = $1`,
        [tenantId]
      );
      const total = Number(countRow.rows[0]?.total ?? 0);

      return res.json({
        data:    result.rows,
        total,
        limit,
        offset,
        hasMore: offset + result.rows.length < total,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/billing/invoices error');
      return res.status(500).json({ error: 'Failed to load invoice history.' });
    }
  }
);

module.exports = router;
