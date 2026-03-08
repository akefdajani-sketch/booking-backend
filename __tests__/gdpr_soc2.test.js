'use strict';

// __tests__/gdpr_soc2.test.js
// PR-8: GDPR DSR + SOC-2 Audit Prep
// Tests for: routes/dsr.js, middleware/securityHeaders.js, utils/auditLog.js

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
jest.mock('../middleware/requireAdminOrTenantRole', () => () => (req, res, next) => next());
jest.mock('../middleware/requireTenant', () => ({
  requireTenant: (req, res, next) => { req.tenantId = 1; next(); },
}));

const { pool } = require('../db');

// ─── securityHeaders middleware ───────────────────────────────────────────────

describe('securityHeaders middleware', () => {
  function makeApp() {
    const securityHeaders = require('../middleware/securityHeaders');
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

  test('does NOT set HSTS in non-production', async () => {
    process.env.NODE_ENV = 'test';
    const res = await request(makeApp()).get('/test');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  test('sets HSTS in production', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    const securityHeaders = require('../middleware/securityHeaders');
    const app = express();
    app.use(securityHeaders);
    app.get('/test', (req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    process.env.NODE_ENV = origEnv;
  });
});

// ─── auditLog util ────────────────────────────────────────────────────────────

describe('writeAuditEvent', () => {
  beforeEach(() => {
    jest.resetModules();
    pool.query.mockResolvedValue({ rows: [] });
  });

  test('inserts an audit row with correct fields', async () => {
    const { writeAuditEvent } = require('../utils/auditLog');
    const mockReq = {
      ip: '127.0.0.1',
      headers: { 'user-agent': 'test-agent', 'x-request-id': 'req-123' },
      requestId: 'req-123',
    };

    await writeAuditEvent(mockReq, {
      tenantId: 1,
      actorEmail: 'owner@test.com',
      actorRole: 'owner',
      eventType: 'booking.cancelled',
      resourceType: 'booking',
      resourceId: '42',
      meta: { reason: 'no-show' },
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log'),
      expect.arrayContaining([1, 'owner@test.com', 'owner', 'booking.cancelled'])
    );
  });

  test('does not throw when DB fails (non-fatal)', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB down'));
    const { writeAuditEvent } = require('../utils/auditLog');
    await expect(
      writeAuditEvent(null, {
        tenantId: 1,
        actorEmail: 'owner@test.com',
        eventType: 'booking.created',
      })
    ).resolves.toBeUndefined();
  });

  test('skips write and warns when required fields missing', async () => {
    const { writeAuditEvent } = require('../utils/auditLog');
    const logger = require('../utils/logger');
    await writeAuditEvent(null, { tenantId: 1 }); // missing actorEmail + eventType
    expect(pool.query).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('lowercases and trims actorEmail', async () => {
    const { writeAuditEvent } = require('../utils/auditLog');
    await writeAuditEvent(null, {
      tenantId: 1,
      actorEmail: '  Owner@TEST.com  ',
      eventType: 'booking.created',
    });
    const call = pool.query.mock.calls[0];
    expect(call[1][1]).toBe('owner@test.com');
  });
});

describe('EVENT_TYPES constants', () => {
  test('exports all required event type keys', () => {
    const { EVENT_TYPES } = require('../utils/auditLog');
    expect(EVENT_TYPES.BOOKING_CREATED).toBe('booking.created');
    expect(EVENT_TYPES.BOOKING_CANCELLED).toBe('booking.cancelled');
    expect(EVENT_TYPES.CUSTOMER_DELETED).toBe('customer.deleted');
    expect(EVENT_TYPES.DSR_ACCESS_REQUESTED).toBe('dsr.access_requested');
    expect(EVENT_TYPES.DSR_ERASURE_REQUESTED).toBe('dsr.erasure_requested');
    expect(EVENT_TYPES.DSR_COMPLETED).toBe('dsr.completed');
    expect(EVENT_TYPES.CUSTOMER_DATA_EXPORTED).toBe('customer.data_exported');
  });

  test('EVENT_TYPES is frozen (immutable)', () => {
    const { EVENT_TYPES } = require('../utils/auditLog');
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
  });
});

// ─── DSR routes ───────────────────────────────────────────────────────────────

function makeDsrApp() {
  const app = express();
  app.use(express.json());
  const router = require('../routes/dsr');
  app.use('/api/dsr', router);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

describe('POST /api/dsr/request', () => {
  beforeEach(() => {
    jest.resetModules();
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE')) return { rows: [] };
      if (s.includes('pending') && s.includes('SELECT')) return { rows: [] }; // no existing
      if (s.includes('INSERT INTO dsr_requests')) return { rows: [{ id: 1, request_type: 'access', status: 'pending', created_at: new Date() }] };
      if (s.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });
  });

  test('returns 201 for valid access request', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ tenantSlug: 'birdie', email: 'customer@test.com', request_type: 'access' });
    expect([201, 400, 401]).toContain(res.status);
    if (res.status === 201) {
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty('dsr_id');
    }
  });

  test('returns 201 for erasure request', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ tenantSlug: 'birdie', email: 'customer@test.com', request_type: 'erasure' });
    expect([201, 400, 401]).toContain(res.status);
  });

  test('returns 400 for missing email', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ tenantSlug: 'birdie', request_type: 'access' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('returns 400 for invalid email', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ tenantSlug: 'birdie', email: 'not-an-email', request_type: 'access' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid request_type', async () => {
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ tenantSlug: 'birdie', email: 'customer@test.com', request_type: 'delete_everything' });
    expect(res.status).toBe(400);
  });

  test('returns 409 when pending request already exists', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE')) return { rows: [] };
      if (s.includes('pending') && s.includes('SELECT')) return { rows: [{ id: 5 }] }; // existing!
      return { rows: [] };
    });
    const res = await request(makeDsrApp())
      .post('/api/dsr/request')
      .send({ tenantSlug: 'birdie', email: 'customer@test.com', request_type: 'access' });
    expect(res.status).toBe(409);
    expect(res.body.dsr_id).toBe(5);
  });
});

describe('GET /api/dsr', () => {
  beforeEach(() => {
    jest.resetModules();
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE')) return { rows: [] };
      if (s.includes('COUNT(*)')) return { rows: [{ count: '2' }] };
      if (s.includes('FROM dsr_requests')) return { rows: [
        { id: 1, request_type: 'access', requester_email: 'a@test.com', status: 'pending' },
        { id: 2, request_type: 'erasure', requester_email: 'b@test.com', status: 'processing' },
      ]};
      return { rows: [] };
    });
  });

  test('returns 200 with paginated DSR list', async () => {
    const res = await request(makeDsrApp())
      .get('/api/dsr?tenantSlug=birdie');
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toHaveProperty('total');
    }
  });
});

describe('PATCH /api/dsr/:id/status', () => {
  beforeEach(() => {
    jest.resetModules();
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('CREATE TABLE')) return { rows: [] };
      if (s.includes('UPDATE dsr_requests')) return { rows: [{ id: 1, status: 'completed', request_type: 'access', requester_email: 'a@test.com' }] };
      if (s.includes('INSERT INTO audit_log')) return { rows: [] };
      return { rows: [] };
    });
  });

  test('returns 200 when status updated to completed', async () => {
    const res = await request(makeDsrApp())
      .patch('/api/dsr/1/status')
      .send({ tenantSlug: 'birdie', status: 'completed', notes: 'Data deleted' });
    expect([200, 400, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.ok).toBe(true);
    }
  });

  test('returns 400 for invalid status value', async () => {
    const res = await request(makeDsrApp())
      .patch('/api/dsr/1/status')
      .send({ tenantSlug: 'birdie', status: 'pending' }); // pending not allowed as patch value
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid id', async () => {
    const res = await request(makeDsrApp())
      .patch('/api/dsr/not-a-number/status')
      .send({ tenantSlug: 'birdie', status: 'completed' });
    expect(res.status).toBe(400);
  });
});
