'use strict';

// utils/stripe.js
// PR-4: Stripe Billing Wiring
//
// Initialises the Stripe SDK from env. Safe no-op when STRIPE_SECRET_KEY is
// not set — billing routes will return 503 rather than crashing the server.
//
// Usage:
//   const { stripe, isStripeEnabled } = require('./utils/stripe');
//   if (!isStripeEnabled()) return res.status(503).json({ error: 'Billing not configured.' });

const logger = require('./logger');

let _stripe = null;

function getStripe() {
  if (_stripe) return _stripe;

  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    logger.warn('STRIPE_SECRET_KEY not set — billing features disabled');
    return null;
  }

  try {
    // Require lazily so the server still boots without stripe installed (CI safety)
    const Stripe = require('stripe');
    _stripe = new Stripe(key, {
      apiVersion: '2024-04-10',
      appInfo: { name: 'flexrz-booking', version: '1.0.0' },
    });
    logger.info('Stripe client initialised');
    return _stripe;
  } catch (err) {
    logger.error({ err }, 'Failed to initialise Stripe client');
    return null;
  }
}

function isStripeEnabled() {
  return Boolean(String(process.env.STRIPE_SECRET_KEY || '').trim());
}

/**
 * Returns the Stripe price ID for a given plan code.
 * Price IDs are set via env vars so they can differ between test/production.
 *
 * Env vars:
 *   STRIPE_PRICE_STARTER  — e.g. price_1234...
 *   STRIPE_PRICE_GROWTH
 *   STRIPE_PRICE_PRO
 */
function getPriceIdForPlan(planCode) {
  const map = {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth:  process.env.STRIPE_PRICE_GROWTH,
    pro:     process.env.STRIPE_PRICE_PRO,
  };
  return map[String(planCode || '').toLowerCase()] || null;
}

module.exports = { getStripe, isStripeEnabled, getPriceIdForPlan };
