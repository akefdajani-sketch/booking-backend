'use strict';

// __tests__/tenant_isolation.test.js
// PR-10: Multi-Tenancy + DX Polish

const express = require('express');
const request = require('supertest');

// ─── Mock DB ──────────────────────────────────────────────────────────────────
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
  initSentry: jest.fn(), captureException: jest.fn(),
  Sentry: { withScope: jest.fn() },
}));

// Mock auth middlewares so requireAdminOrTenantRole can run in tests
jest.mock('../middleware/requireGoogleAuth', () => (req, res, next) => {
  req.googleUser = { sub: 'test-sub', email: 'test@test.com' };
  next();
});
jest.mock('../middleware/ensureUser', () => (req, res, next) => {
  if (req.headers['x-user-id']) {
    req.user = { id: Number(req.headers['x-user-id']) };
  }
  next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApp(router, path = '/api/test') {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

// ─── requireTenant middleware ─────────────────────────────────────────────────

const { requireTenant } = require('../middleware/requireTenant');

describe('requireTenant middleware', () => {
  let app;

  beforeEach(() => {
    mockQuery.mockReset();
    const router = express.Router();
    router.get('/', requireTenant, (req, res) => {
      res.json({ tenantId: req.tenantId, tenantSlug: req.tenantSlug });
    });
    app = makeApp(router);
  });

  it('returns 400 when no tenant context is provided', async () => {
    const res = await request(app).get('/api/test');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
  });

  it('resolves tenant from tenantSlug query param', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
    const res = await request(app).get('/api/test?tenantSlug=birdie-golf');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(42);
    expect(res.body.tenantSlug).toBe('birdie-golf');
  });

  it('returns 400 when tenantSlug is unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/test?tenantSlug=unknown-tenant');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown tenant/i);
  });

  it('resolves tenant from tenantId query param (numeric)', async () => {
    const res = await request(app).get('/api/test?tenantId=7');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(7);
  });

  it('returns 400 for non-numeric tenantId', async () => {
    const res = await request(app).get('/api/test?tenantId=abc');
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative tenantId', async () => {
    const res = await request(app).get('/api/test?tenantId=-1');
    expect(res.status).toBe(400);
  });

  it('rejects when tenantSlug and tenantId do not match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }] });
    const res = await request(app).get('/api/test?tenantSlug=birdie-golf&tenantId=99');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('accepts matching tenantSlug and tenantId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 10 }] });
    const res = await request(app).get('/api/test?tenantSlug=birdie-golf&tenantId=10');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(10);
  });

  it('resolves tenantSlug from x-tenant-slug header', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 55 }] });
    const res = await request(app).get('/api/test').set('x-tenant-slug', 'header-tenant');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(55);
  });

  it('does not let empty tenantSlug header bypass tenant check', async () => {
    const res = await request(app).get('/api/test').set('x-tenant-slug', '   ');
    expect(res.status).toBe(400);
  });
});

// ─── Cross-tenant isolation invariants ───────────────────────────────────────

describe('cross-tenant isolation invariants', () => {
  beforeEach(() => mockQuery.mockReset());

  it('req.tenantId is always a Number, never a string', async () => {
    const router = express.Router();
    let capturedTenantId;
    router.get('/', requireTenant, (req, res) => {
      capturedTenantId = req.tenantId;
      res.json({ ok: true });
    });
    const res = await request(makeApp(router)).get('/api/test?tenantId=5');
    expect(res.status).toBe(200);
    expect(typeof capturedTenantId).toBe('number');
    expect(capturedTenantId).toBe(5);
  });

  it('req.tenant.id matches req.tenantId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 20 }] });
    const router = express.Router();
    let captured;
    router.get('/', requireTenant, (req, res) => {
      captured = { tenantId: req.tenantId, tenantDotId: req.tenant?.id };
      res.json({ ok: true });
    });
    const res = await request(makeApp(router)).get('/api/test?tenantSlug=test-venue');
    expect(res.status).toBe(200);
    expect(captured.tenantId).toBe(captured.tenantDotId);
  });

  it('two requests with different tenantIds get different req.tenantId values', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });

    const router = express.Router();
    router.get('/', requireTenant, (req, res) => res.json({ tenantId: req.tenantId }));
    const app = makeApp(router);

    const [r1, r2] = await Promise.all([
      request(app).get('/api/test?tenantSlug=tenant-a'),
      request(app).get('/api/test?tenantSlug=tenant-b'),
    ]);
    expect(r1.body.tenantId).not.toBe(r2.body.tenantId);
  });
});

// ─── requireTenantRole middleware ─────────────────────────────────────────────

const { requireTenantRole } = require('../middleware/requireTenantRole');

describe('requireTenantRole middleware', () => {
  beforeEach(() => mockQuery.mockReset());

  function makeAuthedApp(role) {
    const router = express.Router();
    router.use((req, _res, next) => {
      req.tenantId = 99;
      req.user = { id: req.headers['x-user-id'] ? Number(req.headers['x-user-id']) : null };
      next();
    });
    router.get('/', requireTenantRole(role), (req, res) => res.json({ ok: true }));
    return makeApp(router);
  }

  it('returns 401 when no user is set', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await request(makeAuthedApp('viewer')).get('/api/test');
    expect([401, 403]).toContain(res.status);
  });

  it('returns 403 when user has no role for this tenant', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await request(makeAuthedApp('viewer')).get('/api/test').set('x-user-id', '5');
    expect([401, 403]).toContain(res.status);
  });

  it('allows access when user has the required role', async () => {
    mockQuery.mockResolvedValue({ rows: [{ role: 'owner' }] });
    const res = await request(makeAuthedApp('viewer')).get('/api/test').set('x-user-id', '5');
    expect(res.status).toBe(200);
  });
});

// ─── requireAdminOrTenantRole middleware ──────────────────────────────────────

const requireAdminOrTenantRole = require('../middleware/requireAdminOrTenantRole');

describe('requireAdminOrTenantRole middleware', () => {
  beforeEach(() => mockQuery.mockReset());

  function makeApp2(role) {
    const router = express.Router();
    router.use((req, _res, next) => {
      req.tenantId = 1;
      // ensureUser mock will set req.user from x-user-id header
      if (req.headers['x-admin-key'] === process.env.ADMIN_API_KEY) {
        req.isAdmin = true;
      }
      next();
    });
    router.get('/', requireAdminOrTenantRole(role), (req, res) => res.json({ ok: true }));
    return makeApp(router);
  }

  it('returns 401/403 with no credentials', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await request(makeApp2('staff')).get('/api/test');
    expect([401, 403]).toContain(res.status);
  });

  it('allows tenant user with correct role', async () => {
    // mockQuery returns the role for requireTenantRole check
    mockQuery.mockResolvedValue({ rows: [{ role: 'owner' }] });
    const res = await request(makeApp2('staff')).get('/api/test').set('x-user-id', '10');
    expect(res.status).toBe(200);
  });
});

// ─── Health route ─────────────────────────────────────────────────────────────

describe('health route (public, no tenant context needed)', () => {
  it('GET /api/health returns 200 without tenant context', async () => {
    // health router mounts GET '/' at the prefix we give it
    mockQuery.mockResolvedValue({ rows: [{ ping: 1 }] });
    const healthRouter = require('../routes/health');
    const app = express();
    app.use(express.json());
    // Mount at /api/health so that router.get('/') → /api/health
    app.use('/api/health', healthRouter);

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
  });
});
