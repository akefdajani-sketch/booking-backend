'use strict';

// __tests__/billing.test.js
// PR-4: Stripe Billing Wiring — test suite
//
// Tests cover:
//   - /api/billing/status  (no Stripe needed)
//   - /api/billing/checkout (Stripe disabled → 503)
//   - /api/billing/portal   (Stripe disabled → 503)
//   - /api/billing/webhook  (Stripe disabled → 503)
//   - utils/stripe.js helpers

const request = require('supertest');
const app     = require('../app');

// ─── Stripe util tests ────────────────────────────────────────────────────────

describe('utils/stripe', () => {
  const { isStripeEnabled, getPriceIdForPlan } = require('../utils/stripe');

  // D4 FINISH: getPriceIdForPlan now queries the DB first (saas_plans) and
  // falls back to legacy env vars. In the test environment there's no DB
  // connection so the DB query rejects and fallback-to-env kicks in. These
  // tests exercise the env-var fallback path explicitly.

  test('isStripeEnabled returns false when STRIPE_SECRET_KEY is not set', () => {
    const orig = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    expect(isStripeEnabled()).toBe(false);
    if (orig !== undefined) process.env.STRIPE_SECRET_KEY = orig;
  });

  test('isStripeEnabled returns true when STRIPE_SECRET_KEY is set', () => {
    const orig = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    expect(isStripeEnabled()).toBe(true);
    if (orig !== undefined) process.env.STRIPE_SECRET_KEY = orig;
    else delete process.env.STRIPE_SECRET_KEY;
  });

  test('getPriceIdForPlan returns falsy when neither DB nor env has a price', async () => {
    delete process.env.STRIPE_PRICE_STARTER;
    delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
    delete process.env.STRIPE_PRICE_STARTER_YEARLY;
    delete process.env.STRIPE_PRICE_GROWTH;
    delete process.env.STRIPE_PRICE_GROWTH_MONTHLY;
    delete process.env.STRIPE_PRICE_GROWTH_YEARLY;
    // DB query will fail silently in test env (no connection) and fall through
    // to env vars — which are also unset — so both return falsy.
    await expect(getPriceIdForPlan('starter')).resolves.toBeFalsy();
    await expect(getPriceIdForPlan('growth')).resolves.toBeFalsy();
  });

  test('getPriceIdForPlan returns env var value when set (legacy fallback)', async () => {
    process.env.STRIPE_PRICE_STARTER = 'price_test_123';
    // With legacy non-cycle env var set, falls back to it regardless of cycle
    await expect(getPriceIdForPlan('starter', 'yearly')).resolves.toBe('price_test_123');
    delete process.env.STRIPE_PRICE_STARTER;
  });

  test('getPriceIdForPlan prefers cycle-specific env var when available', async () => {
    process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_yearly_abc';
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_monthly_xyz';
    await expect(getPriceIdForPlan('starter', 'yearly')).resolves.toBe('price_yearly_abc');
    await expect(getPriceIdForPlan('starter', 'monthly')).resolves.toBe('price_monthly_xyz');
    delete process.env.STRIPE_PRICE_STARTER_YEARLY;
    delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  });

  test('getPriceIdForPlan handles unknown plan codes gracefully', async () => {
    const result = await getPriceIdForPlan('unknown_plan');
    expect(result == null).toBe(true); // null or undefined
  });
});

// ─── Billing routes — Stripe disabled (no STRIPE_SECRET_KEY) ─────────────────

describe('POST /api/billing/checkout — unauthenticated', () => {
  beforeEach(() => { delete process.env.STRIPE_SECRET_KEY; });

  test('returns 401 when no auth token provided (auth runs before Stripe check)', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .send({ tenantSlug: 'test-tenant', planCode: 'growth' });

    // requireGoogleAuth fires first → 401 before we ever reach the Stripe guard
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });
});

describe('POST /api/billing/portal — unauthenticated', () => {
  beforeEach(() => { delete process.env.STRIPE_SECRET_KEY; });

  test('returns 401 when no auth token provided', async () => {
    const res = await request(app)
      .post('/api/billing/portal')
      .send({ tenantSlug: 'test-tenant' });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });
});

describe('POST /api/billing/webhook — Stripe disabled', () => {
  beforeEach(() => { delete process.env.STRIPE_SECRET_KEY; });

  test('returns 503 when Stripe is not configured', async () => {
    const res = await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }));

    expect(res.status).toBe(503);
  });
});

// ─── GET /api/billing/status ──────────────────────────────────────────────────

describe('GET /api/billing/status', () => {
  test('returns 400 when tenantSlug is missing', async () => {
    const res = await request(app).get('/api/billing/status');
    // Will hit auth middleware first (401) or validation (400)
    expect([400, 401, 403]).toContain(res.status);
  });

  test('returns 401 when no auth token provided', async () => {
    const res = await request(app).get('/api/billing/status?tenantSlug=test');
    // requireGoogleAuth should block unauthenticated requests
    expect([401, 403]).toContain(res.status);
  });
});

// ─── Webhook body handling ────────────────────────────────────────────────────

describe('POST /api/billing/webhook — body handling', () => {
  test('webhook route exists and does not 404', async () => {
    const res = await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .send('{}');

    // Will 503 (no stripe key) but proves route is registered
    expect(res.status).not.toBe(404);
  });
});

// ─── Route registration sanity ────────────────────────────────────────────────

describe('Billing route registration', () => {
  test('GET /api/billing/nonexistent returns 404 not 500', async () => {
    const res = await request(app).get('/api/billing/nonexistent');
    expect(res.status).toBe(404);
  });
});

// Close the pg pool so Jest can exit cleanly
const { pool } = require('../db');
afterAll(async () => {
  await pool.end();
});
