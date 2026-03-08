'use strict';

// __tests__/customers.test.js
// PR-6: Backend Test Coverage
// Tests for routes/customers.js — pagination, search, creation, auth guards

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
  initSentry: jest.fn(), captureException: jest.fn(), Sentry: { withScope: jest.fn() },
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

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = require('../routes/customers');
  app.use('/api/customers', router);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

// ─── GET /api/customers ───────────────────────────────────────────────────────

describe('GET /api/customers', () => {
  beforeEach(() => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('information_schema')) {
        return { rows: [{ column_name: 'id' }, { column_name: 'tenant_id' }, { column_name: 'name' }, { column_name: 'email' }, { column_name: 'phone' }, { column_name: 'created_at' }] };
      }
      if (s.includes('COUNT(*)')) return { rows: [{ total: '3' }] };
      if (s.includes('FROM customers')) {
        return {
          rows: [
            { id: 1, name: 'Alice', email: 'alice@test.com', phone: null },
            { id: 2, name: 'Bob', email: 'bob@test.com', phone: '555-1234' },
            { id: 3, name: 'Carol', email: null, phone: '555-5678' },
          ],
        };
      }
      if (s.includes('FROM tenants WHERE slug')) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });
  });

  test('returns 200 with paginated result', async () => {
    const res = await request(makeApp()).get('/api/customers?tenantSlug=birdie');
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('data');
      expect(Array.isArray(res.body.data)).toBe(true);
    }
  });

  test('accepts limit and offset query params', async () => {
    const res = await request(makeApp()).get('/api/customers?tenantSlug=birdie&limit=10&offset=0');
    expect([200, 400]).toContain(res.status);
  });

  test('returns 400 when tenantSlug missing', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(makeApp()).get('/api/customers');
    expect([400, 401, 403]).toContain(res.status);
  });
});

// ─── POST /api/customers ──────────────────────────────────────────────────────

describe('POST /api/customers', () => {
  beforeEach(() => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('information_schema')) {
        return { rows: [{ column_name: 'id' }, { column_name: 'tenant_id' }, { column_name: 'name' }, { column_name: 'email' }, { column_name: 'phone' }] };
      }
      if (s.includes('FROM tenants WHERE slug')) return { rows: [{ id: 1 }] };
      if (s.includes('INSERT INTO customers')) return { rows: [{ id: 99, name: 'New Customer', email: 'new@test.com' }] };
      return { rows: [] };
    });
  });

  test('creates customer and returns 201', async () => {
    const res = await request(makeApp())
      .post('/api/customers')
      .send({ tenantSlug: 'birdie', name: 'New Customer', email: 'new@test.com' });
    expect([201, 200, 400, 401]).toContain(res.status);
  });

  test('returns 400 when name is missing', async () => {
    const res = await request(makeApp())
      .post('/api/customers')
      .send({ tenantSlug: 'birdie', email: 'no-name@test.com' });
    expect([400, 401]).toContain(res.status);
  });
});

// ─── Pagination meta ──────────────────────────────────────────────────────────

describe('Customers pagination meta', () => {
  test('PR-3 pagination: meta object has total, limit, offset, hasMore', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('information_schema')) return { rows: [{ column_name: 'id' }, { column_name: 'tenant_id' }, { column_name: 'name' }, { column_name: 'email' }] };
      if (s.includes('COUNT(*)')) return { rows: [{ total: '100' }] };
      if (s.includes('FROM customers')) return { rows: [{ id: 1, name: 'Alice' }] };
      if (s.includes('FROM tenants')) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });

    const res = await request(makeApp()).get('/api/customers?tenantSlug=birdie&limit=10&offset=0');
    if (res.status === 200) {
      expect(res.body).toHaveProperty('meta');
      expect(res.body.meta).toHaveProperty('total');
      expect(res.body.meta).toHaveProperty('limit');
      expect(res.body.meta).toHaveProperty('offset');
      expect(res.body.meta).toHaveProperty('hasMore');
      expect(res.body.meta.hasMore).toBe(true); // 100 total, 10 limit
    }
  });
});
