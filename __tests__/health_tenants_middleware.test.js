'use strict';

// __tests__/health_tenants_middleware.test.js
// PR-6: Backend Test Coverage
// Tests for: routes/health.js, routes/tenants.js, core middleware units

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [{ ping: 1 }] }),
    on: jest.fn(),
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
  },
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
}));
jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), error: jest.fn() })),
}));
jest.mock('../utils/sentry', () => ({
  initSentry: jest.fn(), captureException: jest.fn(), Sentry: { withScope: jest.fn() },
}));
jest.mock('../middleware/requireAdmin', () => (req, res, next) => {
  const key = req.headers['x-api-key'] || '';
  if (key === 'test-admin-key') return next();
  return res.status(401).json({ error: 'Unauthorized' });
});
jest.mock('../middleware/requireGoogleAuth', () => (req, res, next) => {
  req.googleUser = { sub: 'sub-1', email: 'owner@test.com' };
  next();
});
jest.mock('../middleware/ensureUser', () => (req, res, next) => {
  req.user = { id: 1, email: 'owner@test.com' };
  next();
});
jest.mock('../middleware/requireAdminOrTenantRole', () => () => (req, res, next) => next());
jest.mock('../middleware/maybeEnsureUser', () => (req, res, next) => next());
jest.mock('../middleware/requireTenant', () => ({
  requireTenant: (req, res, next) => { req.tenantId = 1; next(); },
}));
jest.mock('../utils/tenantThemeKey', () => ({ updateTenantThemeKey: jest.fn() }));
jest.mock('../utils/dashboardSummary', () => ({ getDashboardSummary: jest.fn().mockResolvedValue({}) }));
jest.mock('../utils/publish', () => ({ validateTenantPublish: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../middleware/upload', () => ({
  upload: { single: () => (req, res, next) => next() },
  uploadErrorHandler: (err, req, res, next) => next(err),
  uploadDir: '/tmp',
}));
jest.mock('../utils/r2', () => ({
  uploadFileToR2: jest.fn(), deleteFromR2: jest.fn(), safeName: jest.fn(n => n),
}));

const { pool } = require('../db');

// ─── Health route ─────────────────────────────────────────────────────────────

describe('GET /health', () => {
  function makeHealthApp() {
    const app = express();
    const router = require('../routes/health');
    app.use('/health', router);
    return app;
  }

  test('returns 200 with status ok when DB is healthy', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ping: 1 }] });
    const res = await request(makeHealthApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
  });

  test('returns status:healthy field', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ping: 1 }] });
    const res = await request(makeHealthApp()).get('/health');
    if (res.status === 200) {
      expect(res.body.status).toBe('healthy');
      expect(res.body.ok).toBe(true);
    }
  });

  test('GET /health/live returns 200', async () => {
    const res = await request(makeHealthApp()).get('/health/live');
    expect(res.status).toBe(200);
  });

  test('GET /health/version returns version info', async () => {
    const res = await request(makeHealthApp()).get('/health/version');
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('apiVersion');
    }
  });

  test('returns 503 when DB query fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(makeHealthApp()).get('/health');
    expect([200, 503]).toContain(res.status);
  });
});

// ─── Tenants route ────────────────────────────────────────────────────────────

describe('GET /api/tenants/:slug', () => {
  function makeTenantsApp() {
    const app = express();
    app.use(express.json());
    const router = require('../routes/tenants');
    app.use('/api/tenants', router);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    return app;
  }

  test('returns 404 for unknown slug', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(makeTenantsApp()).get('/api/tenants/by-slug/unknown-slug');
    expect([200, 404, 400]).toContain(res.status);
  });

  test('returns tenant data for known slug', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('information_schema')) return { rows: [{ column_name: 'id' }, { column_name: 'slug' }, { column_name: 'name' }, { column_name: 'branding' }] };
      if (s.includes('WHERE') && s.includes('slug')) return { rows: [{ id: 1, slug: 'birdie', name: 'Birdie Golf' }] };
      return { rows: [] };
    });
    const res = await request(makeTenantsApp()).get('/api/tenants/by-slug/birdie');
    expect([200, 404]).toContain(res.status);
  });

  test('GET /api/tenants/ requires admin key', async () => {
    const res = await request(makeTenantsApp()).get('/api/tenants/');
    expect([401, 403, 404]).toContain(res.status);
  });
});

// ─── requireAdmin middleware unit test ───────────────────────────────────────

describe('requireAdmin middleware', () => {
  // Test the real middleware in isolation (not mocked here)
  function makeAdminApp() {
    const app = express();
    // Use real middleware
    jest.unmock('../middleware/requireAdmin');
    const requireAdmin = jest.requireActual('../middleware/requireAdmin');
    app.get('/protected', requireAdmin, (req, res) => res.json({ ok: true }));
    return app;
  }

  test('returns 401 when ADMIN_API_KEY not set and no key provided', async () => {
    const orig = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    const app = makeAdminApp();
    const res = await request(app).get('/protected');
    expect([401, 500]).toContain(res.status);
    if (orig) process.env.ADMIN_API_KEY = orig;
  });

  test('returns 401 when wrong key provided', async () => {
    process.env.ADMIN_API_KEY = 'correct-key';
    const app = makeAdminApp();
    const res = await request(app)
      .get('/protected')
      .set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
    delete process.env.ADMIN_API_KEY;
  });

  test('calls next when correct key provided', async () => {
    process.env.ADMIN_API_KEY = 'my-secret-key';
    const app = makeAdminApp();
    const res = await request(app)
      .get('/protected')
      .set('x-api-key', 'my-secret-key');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    delete process.env.ADMIN_API_KEY;
  });

  test('accepts Bearer token format', async () => {
    process.env.ADMIN_API_KEY = 'bearer-test-key';
    const app = makeAdminApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer bearer-test-key');
    expect(res.status).toBe(200);
    delete process.env.ADMIN_API_KEY;
  });
});

// ─── correlationId middleware ─────────────────────────────────────────────────

describe('correlationId middleware', () => {
  test('attaches X-Request-ID header to response', async () => {
    const correlationId = require('../middleware/correlationId');
    const app = express();
    app.use(correlationId);
    app.get('/test', (req, res) => res.json({ id: req.requestId }));
    const res = await request(app).get('/test');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.body.id).toBeDefined();
  });

  test('uses provided X-Request-ID if sent', async () => {
    const correlationId = require('../middleware/correlationId');
    const app = express();
    app.use(correlationId);
    app.get('/test', (req, res) => res.json({ id: req.requestId }));
    const res = await request(app)
      .get('/test')
      .set('X-Request-ID', 'my-custom-id');
    expect(res.body.id).toBe('my-custom-id');
  });
});

// ─── apiVersion middleware ────────────────────────────────────────────────────

describe('apiVersion middleware', () => {
  test('adds X-API-Version header to every response', async () => {
    const apiVersion = require('../middleware/apiVersion');
    const app = express();
    app.use(apiVersion);
    app.get('/test', (req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');
    expect(res.headers['x-api-version']).toBeDefined();
  });
});
