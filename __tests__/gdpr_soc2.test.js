'use strict';

// __tests__/gdpr_soc2.test.js
// PR-8: GDPR DSR + SOC-2 Audit Prep — FIXED version
// Root cause of original failures: jest.resetModules() in beforeEach caused
// freshly-required modules to get a NEW db instance, disconnected from the
// pool mock captured at the top of the file.
// Fix: require everything once; use mockReset() + mockImplementation() per test.

const express = require('express');
const request = require('supertest');

// ─── Mocks (declared once — never call jest.resetModules() after this) ────────

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
  initSentry: jest.fn(), captureException: jest.fn(),
  Sentry: { withScope: jest.fn() },
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
// requireAdminOrTenantRole is a factory function: (minRole) => middleware
jest.mock('../middleware/requireAdminOrTenantRole', () => () => (req, res, next) => next());
jest.mock('../middleware/requireTenant', () => ({
  requireTenant: (req, res, next) => { req.tenantId = 1; next(); },
}));

const { pool } = require('../db');
const logger   = require('../utils/logger');

// Require modules under test ONCE (same module cache, same db instance)
const { writeAuditEvent, EVENT_TYPES } = require('../utils/auditLog');
const dsrRouter = require('../routes/dsr');

function makeDsrApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dsr', dsrRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

// ─── securityHeaders middleware ───────────────────────────────────────────────

describe('securityHeaders middleware', () => {
  const securityHeaders = require('../middleware/securityHeaders');

  function makeApp() {
    const app = express();
    app.use(securityHeaders);
    app.get('/test', (req, res) => res.json({ ok: true }));
    return app;
  }

  test('sets X-Content-Type-Options: nosniff', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('sets X-Frame-Options: DENY', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  test('sets X-XSS-Protection', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.headers['x-xss-protection']).toBeDefined();
  });

  test('sets Referrer-Policy', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.headers['referrer-policy']).toBeDefined();
  });

  test('sets Permissions-Policy', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.headers['permissions-policy']).toBeDefined();
  });

  test('removes X-Powered-By header', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('does NOT set HSTS in test/non-production', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const res = await request(makeApp()).get('/test');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    process.env.NODE_ENV = origEnv;
  });
});

// ─── auditLog util ────────────────────────────────────────────────────────────

describe('writeAuditEvent', () => {
  beforeEach(() => {
    pool.query.mockReset();
    logger.warn.mockClear();
    logger.error.mockClear();
    pool.query.mockResolvedValue({ rows: [] });
  });

  test('inserts an audit row with correct fields', async () => {
    const mockReq = {
      ip: '127.0.0.1',
      headers: { 'user-agent': 'test-agent', 'x-request-id': 'req-123' },
      requestId: 'req-123',
    };

    await writeAuditEvent(mockReq, {
      tenantId:     1,
      actorEmail:   'owner@test.com',
      actorRole:    'owner',
      eventType:    'booking.cancelled',
      resourceType: 'booking',
      resourceId:   '42',
      meta:         { reason: 'no-show' },
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log'),
      expect.arrayContaining([1, 'owner@test.com', 'owner', 'booking.cancelled'])
    );
  });

  test('does not throw when DB fails (non-fatal)', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB down'));

    await expect(
      writeAuditEvent(null, {
        tenantId:   1,
        actorEmail: 'owner@test.com',
        eventType:  'booking.created',
      })
    ).resolves.toBeUndefined();
  });

  test('skips write and warns when required fields are missing', async () => {
    await writeAuditEvent(null, { tenantId: 1 }); // missing actorEmail + eventType
    expect(pool.query).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('lowercases and trims actorEmail before inserting', async () => {
    await writeAuditEvent(null, {
      tenantId:   1,
      actorEmail: '  Owner@TEST.com  ',
      eventType:  'booking.created',
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const params = pool.query.mock.calls[0][1];
    expect(params[1]).toBe('owner@test.com');
  });

  test('handles null req gracefully (background job usage)', async () => {
    await expect(
      writeAuditEvent(null, {
        tenantId:   1,
        actorEmail: 'system@flexrz.com',
        eventType:  'membership.created',
      })
    ).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('EVENT_TYPES constants', () => {
  test('exports all required event type keys', () => {
    expect(EVENT_TYPES.BOOKING_CREATED).toBe('booking.created');
    expect(EVENT_TYPES.BOOKING_CANCELLED).toBe('booking.cancelled');
    expect(EVENT_TYPES.CUSTOMER_DELETED).toBe('customer.deleted');
    expect(EVENT_TYPES.DSR_ACCESS_REQUESTED).toBe('dsr.access_requested');
    expect(EVENT_TYPES.DSR_ERASURE_REQUESTED).toBe('dsr.erasure_requested');
    expect(EVENT_TYPES.DSR_COMPLETED).toBe('dsr.completed');
    expect(EVENT_TYPES.CUSTOMER_DATA_EXPORTED).toBe('customer.data_exported');
  });

  test('EVENT_TYPES is frozen (immutable)', () => {
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
  });
});

// ─── DSR routes ───────────────────────────────────────────────────────────────

describe('POST /api/dsr/request', () => {
  beforeEach(() => {
    pool.query.mockReset();
    // Default: no existing pending request; INSERT succeeds
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE'))              return { rows: [] };
      if (s.includes('SELECT id FROM dsr_requests')) return { rows: [] }; // no duplicate
      if (s.includes('INSERT INTO dsr_requests'))  return { rows: [{ id: 1, request_type: 'access', status: 'pending', created_at: new Date() }] };
      if (s.includes('INSERT INTO audit_log'))     return { rows: [] };
      return { rows: [] };
    });
  });

  test('returns 201 for valid access request', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ email: 'customer@test.com', request_type: 'access' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('dsr_id');
    expect(res.body.status).toBe('pending');
  });

  test('returns 201 for erasure request', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE'))              return { rows: [] };
      if (s.includes('SELECT id FROM dsr_requests')) return { rows: [] };
      if (s.includes('INSERT INTO dsr_requests'))  return { rows: [{ id: 2, request_type: 'erasure', status: 'pending', created_at: new Date() }] };
      if (s.includes('INSERT INTO audit_log'))     return { rows: [] };
      return { rows: [] };
    });
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ email: 'customer@test.com', request_type: 'erasure' });
    expect(res.status).toBe(201);
    expect(res.body.request_type).toBe('erasure');
  });

  test('erasure response includes 30-day message', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE'))              return { rows: [] };
      if (s.includes('SELECT id FROM dsr_requests')) return { rows: [] };
      if (s.includes('INSERT INTO dsr_requests'))  return { rows: [{ id: 3, request_type: 'erasure', status: 'pending', created_at: new Date() }] };
      if (s.includes('INSERT INTO audit_log'))     return { rows: [] };
      return { rows: [] };
    });
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ email: 'c@test.com', request_type: 'erasure' });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/30 days/i);
  });

  test('returns 400 for missing email', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ request_type: 'access' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('returns 400 for invalid email (no @)', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ email: 'not-an-email', request_type: 'access' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid request_type', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ email: 'customer@test.com', request_type: 'delete_everything' });
    expect(res.status).toBe(400);
  });

  test('returns 409 when a pending request already exists', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE'))              return { rows: [] };
      if (s.includes('SELECT id FROM dsr_requests')) return { rows: [{ id: 5 }] }; // duplicate!
      return { rows: [] };
    });
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ email: 'customer@test.com', request_type: 'access' });
    expect(res.status).toBe(409);
    expect(res.body.dsr_id).toBe(5);
  });
});

describe('GET /api/dsr', () => {
  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE')) return { rows: [] };
      if (s.includes('COUNT(*)'))     return { rows: [{ count: '2' }] };
      if (s.includes('FROM dsr_requests')) return { rows: [
        { id: 1, request_type: 'access',  requester_email: 'a@test.com', status: 'pending',    notes: null, completed_at: null, created_at: new Date(), updated_at: new Date() },
        { id: 2, request_type: 'erasure', requester_email: 'b@test.com', status: 'processing', notes: null, completed_at: null, created_at: new Date(), updated_at: new Date() },
      ]};
      return { rows: [] };
    });
  });

  test('returns 200 with paginated DSR list', async () => {
    const res = await request(makeDsrApp()).get('/api/dsr');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toHaveProperty('total', 2);
  });

  test('meta.hasMore is false when all results fit', async () => {
    const res = await request(makeDsrApp()).get('/api/dsr');
    expect(res.status).toBe(200);
    expect(res.body.meta.hasMore).toBe(false);
  });
});

describe('PATCH /api/dsr/:id/status', () => {
  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE'))          return { rows: [] };
      if (s.includes('UPDATE dsr_requests'))   return { rows: [{ id: 1, status: 'completed', request_type: 'access', requester_email: 'a@test.com' }] };
      if (s.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });
  });

  test('returns 200 when status updated to completed', async () => {
    const res = await request(makeDsrApp())
      .patch('/api/dsr/1/status')
      .send({ status: 'completed', notes: 'Data deleted' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dsr.status).toBe('completed');
  });

  test('returns 200 when status updated to rejected', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE'))          return { rows: [] };
      if (s.includes('UPDATE dsr_requests'))   return { rows: [{ id: 1, status: 'rejected', request_type: 'access', requester_email: 'a@test.com' }] };
      if (s.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });
    const res = await request(makeDsrApp())
      .patch('/api/dsr/1/status')
      .send({ status: 'rejected', notes: 'Legal hold' });
    expect(res.status).toBe(200);
    expect(res.body.dsr.status).toBe('rejected');
  });

  test('returns 400 for invalid status (pending is not a valid patch target)', async () => {
    const res = await request(makeDsrApp())
      .patch('/api/dsr/1/status')
      .send({ status: 'pending' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for non-numeric id', async () => {
    const res = await request(makeDsrApp())
      .patch('/api/dsr/not-a-number/status')
      .send({ status: 'completed' });
    expect(res.status).toBe(400);
  });

  test('returns 404 when DSR not found for tenant', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE'))          return { rows: [] };
      if (s.includes('UPDATE dsr_requests'))   return { rows: [] }; // 0 rows = not found
      return { rows: [] };
    });
    const res = await request(makeDsrApp())
      .patch('/api/dsr/999/status')
      .send({ status: 'completed' });
    expect(res.status).toBe(404);
  });
});
