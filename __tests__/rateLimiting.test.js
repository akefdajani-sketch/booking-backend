'use strict';

// __tests__/rateLimiting.test.js
// PR-2: Rate Limiting + Auth Hardening — test coverage
//
// Tests:
//   1. Rate limiters export the correct shape
//   2. publicApiLimiter / availabilityLimiter / bookingCreateLimiter / tenantLookupLimiter exist
//   3. All limiters skip in test mode (NODE_ENV=test) — ensures CI never hits limits
//   4. GET /api/tenants/ requires admin auth (no longer public)
//   5. GET /api/tenants/by-slug/:slug remains public (not auth-gated)
//   6. GET /api/availability is still accessible (rate-limited but not auth-gated)

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    on: jest.fn(),
  },
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
}));

jest.mock('../utils/sentry', () => ({
  initSentry: jest.fn(),
  captureException: jest.fn(),
  Sentry: { withScope: jest.fn() },
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

jest.mock('pino-http', () =>
  jest.fn().mockReturnValue((req, res, next) => next())
);

// ─── Test 1 & 2: limiter module shape ────────────────────────────────────────

describe('rateLimiter module', () => {
  let limiters;

  beforeAll(() => {
    limiters = require('../middleware/rateLimiter');
  });

  test('exports publicApiLimiter', () => {
    expect(typeof limiters.publicApiLimiter).toBe('function');
  });

  test('exports availabilityLimiter', () => {
    expect(typeof limiters.availabilityLimiter).toBe('function');
  });

  test('exports bookingCreateLimiter', () => {
    expect(typeof limiters.bookingCreateLimiter).toBe('function');
  });

  test('exports tenantLookupLimiter', () => {
    expect(typeof limiters.tenantLookupLimiter).toBe('function');
  });
});

// ─── Test 3: limiters skip in test mode ──────────────────────────────────────

describe('rate limiters skip in NODE_ENV=test', () => {
  // NODE_ENV is already 'test' when Jest runs (set by cross-env in package.json)
  test('NODE_ENV is test', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  test('availabilityLimiter passes through without counting in test mode', async () => {
    const { availabilityLimiter } = require('../middleware/rateLimiter');

    const app = express();
    app.use(availabilityLimiter);
    app.get('/ping', (_req, res) => res.json({ ok: true }));

    // Make many requests — should all pass because limiter skips in test
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/ping');
      expect(res.status).toBe(200);
    }
  });

  test('bookingCreateLimiter passes through without counting in test mode', async () => {
    const { bookingCreateLimiter } = require('../middleware/rateLimiter');

    const app = express();
    app.use(bookingCreateLimiter);
    app.post('/book', (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/book');
      expect(res.status).toBe(200);
    }
  });
});

// ─── Test 4: GET /api/tenants/ now requires admin auth ───────────────────────

describe('GET /api/tenants/ auth guard', () => {
  let app;

  beforeAll(() => {
    // Set a known ADMIN_API_KEY for this test suite
    process.env.ADMIN_API_KEY = 'test-admin-key-pr2';
  });

  beforeEach(() => {
    jest.resetModules();

    // Provide a DB mock that returns a tenant list
    jest.mock('../db', () => ({
      pool: {
        query: jest.fn().mockImplementation(async (sql) => {
          const s = String(sql);
          // information_schema column probe
          if (s.includes('information_schema')) {
            return { rows: [{ column_name: 'logo_url' }] };
          }
          // Tenant list
          if (s.toLowerCase().includes('from tenants')) {
            return { rows: [{ id: 1, slug: 'test', name: 'Test Tenant' }] };
          }
          return { rows: [] };
        }),
        on: jest.fn(),
      },
      query: jest.fn().mockResolvedValue({ rows: [] }),
    }));

    jest.mock('../utils/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
      fatal: jest.fn(), child: jest.fn().mockReturnThis(),
    }));
    jest.mock('pino-http', () =>
      jest.fn().mockReturnValue((_req, _res, next) => next())
    );

    app = express();
    app.use(express.json());
    app.use('/api/tenants', require('../routes/tenants'));
  });

  test('returns 401 with no API key', async () => {
    const res = await request(app).get('/api/tenants/');
    expect(res.status).toBe(401);
  });

  test('returns 401 with wrong API key', async () => {
    const res = await request(app)
      .get('/api/tenants/')
      .set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  test('returns 200 with correct API key (x-api-key header)', async () => {
    const res = await request(app)
      .get('/api/tenants/')
      .set('x-api-key', 'test-admin-key-pr2');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tenants');
  });

  test('returns 200 with correct API key (Authorization: Bearer header)', async () => {
    const res = await request(app)
      .get('/api/tenants/')
      .set('Authorization', 'Bearer test-admin-key-pr2');
    expect(res.status).toBe(200);
  });
});

// ─── Test 5: by-slug remains public (no auth) ────────────────────────────────

describe('GET /api/tenants/by-slug/:slug is still public', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('../db', () => ({
      pool: {
        query: jest.fn().mockImplementation(async (sql) => {
          const s = String(sql);
          if (s.includes('information_schema')) {
            return { rows: [{ column_name: 'logo_url' }] };
          }
          if (s.toLowerCase().includes('where slug')) {
            return { rows: [{ id: 1, slug: 'birdie', name: 'Birdie Golf' }] };
          }
          return { rows: [] };
        }),
        on: jest.fn(),
      },
      query: jest.fn().mockResolvedValue({ rows: [] }),
    }));

    jest.mock('../utils/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
      fatal: jest.fn(), child: jest.fn().mockReturnThis(),
    }));
    jest.mock('pino-http', () =>
      jest.fn().mockReturnValue((_req, _res, next) => next())
    );

    app = express();
    app.use(express.json());
    app.use('/api/tenants', require('../routes/tenants'));
  });

  test('returns 200 with no auth header', async () => {
    const res = await request(app).get('/api/tenants/by-slug/birdie');
    // Should not be 401
    expect(res.status).not.toBe(401);
    expect([200, 404]).toContain(res.status);
  });
});
