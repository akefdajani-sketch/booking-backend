'use strict';

// __tests__/apiV3.test.js
// PR-3: Health enrichment, API versioning, pagination — test coverage

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [{ ping: 1 }] }),
    on: jest.fn(),
  },
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
}));

jest.mock('../utils/sentry', () => ({
  initSentry: jest.fn(),
  captureException: jest.fn(),
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

// ─── 1. apiVersion middleware ─────────────────────────────────────────────────

describe('apiVersion middleware', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(require('../middleware/apiVersion'));
    app.get('/test', (_req, res) => res.json({ ok: true }));
  });

  test('adds X-API-Version header to every response', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.headers['x-api-version']).toBe('1');
  });

  test('header is present on 404 responses too', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.headers['x-api-version']).toBe('1');
  });
});

// ─── 2. Health endpoint enrichment ───────────────────────────────────────────

describe('GET /health enrichment', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../db', () => ({
      pool: {
        query: jest.fn().mockResolvedValue({ rows: [{ ping: 1 }] }),
        on: jest.fn(),
      },
    }));
    jest.mock('../utils/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
      fatal: jest.fn(), child: jest.fn().mockReturnThis(),
    }));

    app = express();
    app.use('/health', require('../routes/health'));
  });

  test('returns ok:true when DB is healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('includes status field', async () => {
    const res = await request(app).get('/health');
    expect(res.body.status).toBe('healthy');
  });

  test('includes service field', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('service');
  });

  test('includes apiVersion field', async () => {
    const res = await request(app).get('/health');
    expect(res.body.apiVersion).toBe('1');
  });

  test('includes environment field', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('environment');
  });

  test('includes version field', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('version');
  });

  test('returns 503 when DB fails', async () => {
    jest.resetModules();
    jest.mock('../db', () => ({
      pool: {
        query: jest.fn().mockRejectedValue(new Error('DB down')),
        on: jest.fn(),
      },
    }));
    jest.mock('../utils/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
      fatal: jest.fn(), child: jest.fn().mockReturnThis(),
    }));

    const sickApp = express();
    sickApp.use('/health', require('../routes/health'));
    const res = await request(sickApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('degraded');
  });

  test('GET /health/live returns ok and uptime', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('uptime');
  });

  test('GET /health/version returns version info', async () => {
    const res = await request(app).get('/health/version');
    expect(res.status).toBe(200);
    expect(res.body.apiVersion).toBe('1');
    expect(res.body).toHaveProperty('service');
    expect(res.body).toHaveProperty('nodeVersion');
  });
});

// ─── 3. Customers pagination meta ────────────────────────────────────────────

describe('GET /api/customers pagination meta', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('../db', () => ({
      pool: {
        query: jest.fn().mockImplementation(async (sql, params) => {
          const s = String(sql);
          if (s.includes('COUNT(*)')) {
            return { rows: [{ total: 42 }] };
          }
          if (s.includes('information_schema')) {
            return { rows: [{ column_name: 'name' }, { column_name: 'created_at' }, { column_name: 'phone' }, { column_name: 'email' }, { column_name: 'notes' }] };
          }
          return { rows: [{ id: 1, name: 'Alice', phone: null, email: null, notes: null, tenant_id: 1, tenant_slug: 't', tenant_name: 'T', created_at: new Date() }] };
        }),
        on: jest.fn(),
      },
    }));

    jest.mock('../middleware/requireTenant', () => ({
      requireTenant: (req, _res, next) => { req.tenantId = 1; next(); },
    }));
    jest.mock('../middleware/requireAdminOrTenantRole', () => () => (_req, _res, next) => next());
    jest.mock('../middleware/requireGoogleAuth', () => (_req, _res, next) => next());
    jest.mock('../utils/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
      fatal: jest.fn(), child: jest.fn().mockReturnThis(),
    }));

    app = express();
    app.use(express.json());
    app.use('/api/customers', require('../routes/customers'));
  });

  test('returns meta object with total, limit, offset, hasMore', async () => {
    const res = await request(app).get('/api/customers/?tenantSlug=test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('total');
    expect(res.body.meta).toHaveProperty('limit');
    expect(res.body.meta).toHaveProperty('offset');
    expect(res.body.meta).toHaveProperty('hasMore');
  });

  test('default limit is 50', async () => {
    const res = await request(app).get('/api/customers/?tenantSlug=test');
    expect(res.body.meta.limit).toBe(50);
  });

  test('default offset is 0', async () => {
    const res = await request(app).get('/api/customers/?tenantSlug=test');
    expect(res.body.meta.offset).toBe(0);
  });

  test('respects custom limit param', async () => {
    const res = await request(app).get('/api/customers/?tenantSlug=test&limit=25');
    expect(res.body.meta.limit).toBe(25);
  });

  test('respects offset param', async () => {
    const res = await request(app).get('/api/customers/?tenantSlug=test&offset=10');
    expect(res.body.meta.offset).toBe(10);
  });

  test('hasMore is true when there are more results', async () => {
    // total=42, offset=0, returning 1 row → hasMore should be true
    const res = await request(app).get('/api/customers/?tenantSlug=test');
    expect(res.body.meta.hasMore).toBe(true);
  });
});
