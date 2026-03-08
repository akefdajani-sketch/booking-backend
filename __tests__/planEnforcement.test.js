'use strict';

// __tests__/planEnforcement.test.js
// PR-6: Backend Test Coverage
// Tests for utils/planEnforcement.js — the core billing/limit logic

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();

jest.mock('../db', () => ({
  pool: { query: mockQuery, on: jest.fn() },
  query: mockQuery,
  connect: jest.fn(),
}));
jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), error: jest.fn() })),
}));
jest.mock('../utils/sentry', () => ({
  initSentry: jest.fn(), captureException: jest.fn(), Sentry: { withScope: jest.fn() },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

const {
  assertWithinPlanLimit,
  getPlanSummaryForTenant,
  PLAN_CODES,
  FEATURE_KEYS,
} = require('../utils/planEnforcement');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockSubscription(planCode = 'growth', status = 'active', trialEndsAt = null) {
  return {
    id: 1,
    status,
    trial_ends_at: trialEndsAt,
    plan_id: 10,
    plan_code: planCode,
    plan_name: planCode.charAt(0).toUpperCase() + planCode.slice(1),
  };
}

function mockFeatures(servicesLimit = 15, staffLimit = 10, resourcesLimit = 10) {
  return [
    { feature_key: 'limit_services', enabled: true, limit_value: servicesLimit },
    { feature_key: 'limit_staff',    enabled: true, limit_value: staffLimit },
    { feature_key: 'limit_resources', enabled: true, limit_value: resourcesLimit },
    { feature_key: 'memberships',    enabled: true, limit_value: null },
  ];
}

// ─── PLAN_CODES and FEATURE_KEYS constants ────────────────────────────────────

describe('Plan constants', () => {
  test('PLAN_CODES has starter, growth, pro', () => {
    expect(PLAN_CODES.starter).toBe('starter');
    expect(PLAN_CODES.growth).toBe('growth');
    expect(PLAN_CODES.pro).toBe('pro');
  });

  test('FEATURE_KEYS has limit_services and limit_staff', () => {
    expect(FEATURE_KEYS.limitServices).toBe('limit_services');
    expect(FEATURE_KEYS.limitStaff).toBe('limit_staff');
  });
});

// ─── assertWithinPlanLimit ────────────────────────────────────────────────────

describe('assertWithinPlanLimit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the internal _ensured flag by re-requiring the module
    jest.resetModules();
  });

  test('returns ok:true during active trial', async () => {
    // Re-require to reset internal state
    const { assertWithinPlanLimit: check } = require('../utils/planEnforcement');

    const trialEnd = new Date(Date.now() + 86400000).toISOString(); // 1 day from now
    mockQuery.mockImplementation(async (sql) => {
      const s = String(sql);
      // ensurePlanTables calls
      if (s.includes('CREATE TABLE')) return { rows: [] };
      if (s.includes('ALTER TABLE')) return { rows: [] };
      if (s.includes('INSERT INTO saas_plans')) return { rows: [{ id: 1 }] };
      if (s.includes('INSERT INTO saas_plan_features')) return { rows: [] };
      if (s.includes('ON CONFLICT (code)')) return { rows: [{ id: 1 }] };
      if (s.includes('ON CONFLICT (plan_id')) return { rows: [] };
      // getLatestSubscription
      if (s.includes('FROM tenant_subscriptions')) return { rows: [mockSubscription('starter', 'trialing', trialEnd)] };
      return { rows: [] };
    });

    const result = await check(1, 'services');
    expect(result.ok).toBe(true);
  });

  test('throws PLAN_LIMIT_REACHED when at limit', async () => {
    const { assertWithinPlanLimit: check } = require('../utils/planEnforcement');

    mockQuery.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE') || s.includes('ALTER TABLE')) return { rows: [] };
      if (s.includes('ON CONFLICT (code)')) return { rows: [{ id: 1 }] };
      if (s.includes('ON CONFLICT (plan_id')) return { rows: [] };
      if (s.includes('FROM tenant_subscriptions')) return { rows: [mockSubscription('starter', 'active', null)] };
      if (s.includes('FROM saas_plan_features')) return { rows: mockFeatures(5, 3, 3) };
      // Usage: already at limit
      if (s.includes('COUNT(*)') && s.includes('services')) return { rows: [{ services_count: 5, staff_count: 1, resources_count: 1 }] };
      return { rows: [] };
    });

    await expect(check(1, 'services')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      kind: 'services',
      limit: 5,
    });
  });

  test('returns ok:true when under limit', async () => {
    const { assertWithinPlanLimit: check } = require('../utils/planEnforcement');

    mockQuery.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE') || s.includes('ALTER TABLE')) return { rows: [] };
      if (s.includes('ON CONFLICT (code)')) return { rows: [{ id: 1 }] };
      if (s.includes('ON CONFLICT (plan_id')) return { rows: [] };
      if (s.includes('FROM tenant_subscriptions')) return { rows: [mockSubscription('growth', 'active', null)] };
      if (s.includes('FROM saas_plan_features')) return { rows: mockFeatures(15, 10, 10) };
      if (s.includes('COUNT(*)')) return { rows: [{ services_count: 3, staff_count: 1, resources_count: 1 }] };
      return { rows: [] };
    });

    const result = await check(1, 'services');
    expect(result.ok).toBe(true);
  });

  test('returns ok:true for pro plan (unlimited — null limit)', async () => {
    const { assertWithinPlanLimit: check } = require('../utils/planEnforcement');

    mockQuery.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE') || s.includes('ALTER TABLE')) return { rows: [] };
      if (s.includes('ON CONFLICT (code)')) return { rows: [{ id: 1 }] };
      if (s.includes('ON CONFLICT (plan_id')) return { rows: [] };
      if (s.includes('FROM tenant_subscriptions')) return { rows: [mockSubscription('pro', 'active', null)] };
      // Pro: null limit_value = unlimited
      if (s.includes('FROM saas_plan_features')) return { rows: [{ feature_key: 'limit_services', enabled: true, limit_value: null }] };
      return { rows: [] };
    });

    const result = await check(1, 'services');
    expect(result.ok).toBe(true);
  });

  test('creates default starter trial subscription for new tenant', async () => {
    const { assertWithinPlanLimit: check } = require('../utils/planEnforcement');

    let insertCalled = false;
    mockQuery.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE') || s.includes('ALTER TABLE')) return { rows: [] };
      if (s.includes('ON CONFLICT (code)')) return { rows: [{ id: 1 }] };
      if (s.includes('ON CONFLICT (plan_id')) return { rows: [] };
      // First call: no subscription found
      if (s.includes('FROM tenant_subscriptions s') && !insertCalled) return { rows: [] };
      // Insert new trialing subscription
      if (s.includes('INSERT INTO tenant_subscriptions')) {
        insertCalled = true;
        return { rows: [{ id: 99 }] };
      }
      // Second fetch after insert
      if (s.includes('FROM tenant_subscriptions s') && insertCalled) {
        const trialEnd = new Date(Date.now() + 86400000 * 14).toISOString();
        return { rows: [mockSubscription('starter', 'trialing', trialEnd)] };
      }
      if (s.includes('FROM saas_plans WHERE code')) return { rows: [{ id: 1 }] };
      if (s.includes('NOW() +')) return { rows: [{ trial_ends_at: new Date().toISOString() }] };
      return { rows: [] };
    });

    // New tenant on trial — should be allowed
    const result = await check(99, 'services');
    expect(result.ok).toBe(true);
  });
});

// ─── getPlanSummaryForTenant ──────────────────────────────────────────────────

describe('getPlanSummaryForTenant', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('returns subscription, limits, features, usage', async () => {
    const { getPlanSummaryForTenant: getSummary } = require('../utils/planEnforcement');

    mockQuery.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE') || s.includes('ALTER TABLE')) return { rows: [] };
      if (s.includes('ON CONFLICT (code)')) return { rows: [{ id: 1 }] };
      if (s.includes('ON CONFLICT (plan_id')) return { rows: [] };
      if (s.includes('FROM tenant_subscriptions')) return { rows: [mockSubscription('growth', 'active')] };
      if (s.includes('FROM saas_plan_features')) return { rows: mockFeatures(15, 10, 10) };
      if (s.includes('COUNT(*)')) return { rows: [{ services_count: 3, staff_count: 2, resources_count: 1 }] };
      return { rows: [] };
    });

    const summary = await getSummary(1);
    expect(summary).toHaveProperty('subscription');
    expect(summary).toHaveProperty('limits');
    expect(summary).toHaveProperty('features');
    expect(summary).toHaveProperty('usage');
    expect(summary.subscription.plan_code).toBe('growth');
    expect(summary.usage.services_count).toBe(3);
  });
});
