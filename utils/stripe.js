'use strict';

// utils/stripe.js
// PR-4: Stripe Billing Wiring
// D4.2: DB-first price ID resolution with cycle (yearly|monthly) awareness.
//
// Initialises the Stripe SDK from env. Safe no-op when STRIPE_SECRET_KEY is
// not set — billing routes will return 503 rather than crashing the server.
//
// Usage:
//   const { getStripe, isStripeEnabled, getPriceIdForPlan } = require('./utils/stripe');
//   const priceId = await getPriceIdForPlan('growth', 'yearly');

const logger = require('./logger');
const db = require('../db');

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
 * Async. Returns the Stripe price ID for a given plan + billing cycle.
 *
 * Resolution order:
 *   1. saas_plans.stripe_price_id_yearly  or stripe_price_id_monthly (DB source of truth)
 *   2. STRIPE_PRICE_<PLAN>_<CYCLE>        env var (e.g. STRIPE_PRICE_GROWTH_MONTHLY)
 *   3. STRIPE_PRICE_<PLAN>                env var (legacy, cycle-agnostic — treated as yearly)
 *
 * The DB path is the new D4 behavior — operators create Products + Prices in Stripe
 * Dashboard, copy the price_xxx IDs into saas_plans, and Checkout reads them dynamically.
 *
 * The env-var fallback keeps older deployments working while they migrate to DB-driven.
 */
async function getPriceIdForPlan(planCode, cycle = 'yearly') {
  const code = String(planCode || '').trim().toLowerCase();
  const cy   = String(cycle || 'yearly').trim().toLowerCase();

  if (!code) return null;
  if (cy !== 'yearly' && cy !== 'monthly') {
    logger.warn({ cycle: cy }, 'getPriceIdForPlan: unknown cycle, defaulting to yearly');
  }

  const column = cy === 'monthly' ? 'stripe_price_id_monthly' : 'stripe_price_id_yearly';

  // ── 1. DB lookup ─────────────────────────────────────────────────────────
  try {
    const { rows } = await db.query(
      `SELECT ${column} AS price_id FROM saas_plans WHERE code = $1 LIMIT 1`,
      [code]
    );
    const dbPriceId = rows[0]?.price_id;
    if (dbPriceId) return dbPriceId;
  } catch (err) {
    // Column may not exist yet if migration 039 hasn't run. Fall through to env.
    if (!/column .* does not exist/i.test(err.message || '')) {
      logger.warn({ err: err.message, code, cy }, 'getPriceIdForPlan: DB lookup failed, falling back to env');
    }
  }

  // ── 2. Cycle-specific env fallback ───────────────────────────────────────
  const cycleEnvKey = `STRIPE_PRICE_${code.toUpperCase()}_${cy.toUpperCase()}`;
  const cycleEnvVal = process.env[cycleEnvKey];
  if (cycleEnvVal) return cycleEnvVal;

  // ── 3. Legacy cycle-agnostic env fallback ────────────────────────────────
  const legacyEnvKey = `STRIPE_PRICE_${code.toUpperCase()}`;
  const legacyEnvVal = process.env[legacyEnvKey];
  if (legacyEnvVal) {
    logger.warn(
      { code, cy, legacyEnvKey },
      'getPriceIdForPlan: using legacy env var (no cycle variant). Populate saas_plans.stripe_price_id_* to remove this warning.'
    );
    return legacyEnvVal;
  }

  return null;
}

module.exports = { getStripe, isStripeEnabled, getPriceIdForPlan };
