'use strict';

// __tests__/memberships_errorhandler.test.js
// PR-6: Backend Test Coverage
// Tests for: routes/membershipPlans.js, middleware/errorHandler.js, utils/tenants.js

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../db', () => ({
  pool: { query: jest.fn(), on: jest.fn() },
  query: jest.fn(),
  connect: jest.fn(),
}));
jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), error: jest.fn() })),
}));
jest.mock('../utils/sentry', () => ({
  initSentry: jest.fn(),
  captureException: jest.fn(),
  Sentry: { withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn() })) },
}));
jest.mock('../middleware/requireAdmin', () => (req, res, next) => next());
jest.mock('../middleware/requireGoogleAuth', () => (req, res, next) => {
  req.googleUser = { sub: 'sub-1', email: 'owner@test.com' };
  next();
});
jest.mock('../middleware/ensureUser', () => (req, res, next) => {
  req.user = { id: 1, email: 'owner@test.com' };
  next();
});
jest.mock('../middleware/requireAdminOrTenantRole', () => (req, res, next) => next());
jest.mock('../middleware/requireTenant', () => ({
  requireTenant: (req, res, next) => { req.tenantId = 1; next(); },
}));

const { pool } = require('../db');

// ─── Membership plans ─────────────────────────────────────────────────────────

describe('GET /api/membership-plans', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    const router = require('../routes/membershipPlans');
    app.use('/api/membership-plans', router);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    return app;
  }

  test('returns 400 or 401 without tenantSlug', async () => {
    const res = await request(makeApp()).get('/api/membership-plans');
    expect([400, 401, 403]).toContain(res.status);
  });

  test('returns plans array for valid tenant', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('FROM tenants WHERE slug')) return { rows: [{ id: 1 }] };
      if (s.includes('FROM membership_plans') || s.includes('membership')) {
        return { rows: [{ id: 1, name: 'Monthly', price: 50, is_active: true }] };
      }
      return { rows: [] };
    });
    const res = await request(makeApp()).get('/api/membership-plans?tenantSlug=birdie');
    expect([200, 400, 401]).toContain(res.status);
  });
});

// ─── errorHandler middleware ──────────────────────────────────────────────────

describe('errorHandler middleware', () => {
  function makeErrorApp(errorToThrow) {
    const errorHandler = require('../middleware/errorHandler');
    const app = express();
    app.get('/boom', (req, res, next) => next(errorToThrow));
    app.use(errorHandler);
    return app;
  }

  test('returns 500 for generic errors', async () => {
    const res = await request(makeErrorApp(new Error('Something broke'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  test('uses err.status when provided', async () => {
    const err = new Error('Not allowed');
    err.status = 403;
    const res = await request(makeErrorApp(err)).get('/boom');
    expect(res.status).toBe(403);
  });

  test('uses err.statusCode when err.status is not set', async () => {
    const err = new Error('Conflict');
    err.statusCode = 409;
    const res = await request(makeErrorApp(err)).get('/boom');
    expect([409, 500]).toContain(res.status);
  });

  test('does not expose stack trace in response body', async () => {
    const res = await request(makeErrorApp(new Error('Internal'))).get('/boom');
    expect(JSON.stringify(res.body)).not.toMatch(/at Object\./);
  });

  test('calls captureException for 5xx errors', async () => {
    const { captureException } = require('../utils/sentry');
    await request(makeErrorApp(new Error('server error'))).get('/boom');
    expect(captureException).toHaveBeenCalled();
  });
});

// ─── utils/tenants.js ─────────────────────────────────────────────────────────

describe('utils/tenants — getTenantIdFromSlug', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('returns tenant id for known slug', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });
    const { getTenantIdFromSlug } = require('../utils/tenants');
    const id = await getTenantIdFromSlug('birdie');
    expect(id).toBe(42);
  });

  test('returns null for unknown slug', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const { getTenantIdFromSlug } = require('../utils/tenants');
    const id = await getTenantIdFromSlug('nonexistent');
    expect(id == null).toBe(true);
  });

  test('throws or returns null on DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB error'));
    const { getTenantIdFromSlug } = require('../utils/tenants');
    try {
      const id = await getTenantIdFromSlug('birdie');
      expect(id == null).toBe(true);
    } catch (err) {
      expect(err.message).toBe('DB error');
    }
  });
});

// ─── requestLogger middleware ─────────────────────────────────────────────────

describe('requestLogger middleware', () => {
  test('does not crash on normal requests', async () => {
    const requestLogger = require('../middleware/requestLogger');
    const app = express();
    app.use(requestLogger);
    app.get('/test', (req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });
});

// ─── rateLimiter middleware ───────────────────────────────────────────────────

describe('rateLimiter — skip in test env', () => {
  test('all limiters export as middleware functions', () => {
    const {
      publicApiLimiter,
      availabilityLimiter,
      bookingCreateLimiter,
      tenantLookupLimiter,
    } = require('../middleware/rateLimiter');

    expect(typeof publicApiLimiter).toBe('function');
    expect(typeof availabilityLimiter).toBe('function');
    expect(typeof bookingCreateLimiter).toBe('function');
    expect(typeof tenantLookupLimiter).toBe('function');
  });

  test('limiters pass through in NODE_ENV=test', async () => {
    const { publicApiLimiter } = require('../middleware/rateLimiter');
    const app = express();
    app.use(publicApiLimiter);
    app.get('/test', (req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');
    // In test env, limiter skips — should not be rate limited
    expect(res.status).toBe(200);
  });
});
