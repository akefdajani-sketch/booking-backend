'use strict';

// __tests__/contracts.test.js
// G2a-1: Tests for utils/contracts.js + routes/contracts/* + routes/paymentScheduleTemplates.js

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockConnect = jest.fn();
jest.mock('../db', () => ({
  pool: { query: mockQuery, connect: mockConnect, on: jest.fn() },
  query: mockQuery,
  connect: mockConnect,
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), error: jest.fn() })),
}));

jest.mock('../middleware/requireAppAuth', () => (req, res, next) => {
  req.googleUser = { sub: 'test', email: 'test@test.com' };
  req.auth = req.googleUser;
  next();
});
jest.mock('../middleware/requireGoogleAuth', () => (req, res, next) => {
  req.googleUser = { sub: 'test', email: 'test@test.com' };
  next();
});
jest.mock('../middleware/requireTenant', () => ({
  requireTenant: (req, res, next) => {
    req.tenantId = Number(req.headers['x-test-tenant-id'] || 33);
    req.tenantSlug = req.headers['x-test-tenant-slug'] || 'aqababooking';
    next();
  },
}));
jest.mock('../middleware/requireAdminOrTenantRole', () => () => (req, res, next) => next());
jest.mock('../middleware/ensureUser', () => (req, res, next) => next());
jest.mock('../middleware/requireTenantRole', () => ({
  requireTenantRole: () => (req, res, next) => next(),
}));

// ─── Helper: app under test ───────────────────────────────────────────────────

function makeApp(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

// ─── utils/contracts.js ───────────────────────────────────────────────────────

describe('utils/contracts — helpers', () => {
  const contracts = require('../utils/contracts');

  describe('resolveContractPrefix', () => {
    test('uses stored prefix when valid (backfilled value)', () => {
      // Stored prefix takes priority over slug truncation.
      // For aqababooking the backfill SQL sets 'AQB' which differs from
      // UPPER(LEFT('aqababooking',3)) = 'AQA'. This is intentional.
      expect(contracts.resolveContractPrefix({ contract_number_prefix: 'AQB', slug: 'aqababooking' })).toBe('AQB');
    });
    test('falls back to UPPER(LEFT(slug,3)) when prefix is null', () => {
      // No backfill → derive from slug truncation. birdiegolf → BIR.
      expect(contracts.resolveContractPrefix({ contract_number_prefix: null, slug: 'birdiegolf' })).toBe('BIR');
      // And aqababooking → AQA (truncation, not the backfill value AQB)
      expect(contracts.resolveContractPrefix({ contract_number_prefix: null, slug: 'aqababooking' })).toBe('AQA');
    });
    test('ignores invalid stored prefix (lowercase) and falls back to slug truncation', () => {
      expect(contracts.resolveContractPrefix({ contract_number_prefix: 'bir', slug: 'birdiegolf' })).toBe('BIR');
    });
    test('pads too-short slug fallback', () => {
      const out = contracts.resolveContractPrefix({ contract_number_prefix: null, slug: 'a' });
      expect(out.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('deriveStayType', () => {
    test('returns null for time_slots booking', () => {
      expect(contracts.deriveStayType({ booking_mode: 'time_slots', nights_count: 30 })).toBeNull();
    });
    test('nightly when nights_count <= 14', () => {
      expect(contracts.deriveStayType({ booking_mode: 'nightly', nights_count: 1 })).toBe('nightly');
      expect(contracts.deriveStayType({ booking_mode: 'nightly', nights_count: 14 })).toBe('nightly');
    });
    test('long_stay when 15..60 nights', () => {
      expect(contracts.deriveStayType({ booking_mode: 'nightly', nights_count: 15 })).toBe('long_stay');
      expect(contracts.deriveStayType({ booking_mode: 'nightly', nights_count: 60 })).toBe('long_stay');
    });
    test('contract_stay when >= 61 nights', () => {
      expect(contracts.deriveStayType({ booking_mode: 'nightly', nights_count: 61 })).toBe('contract_stay');
      expect(contracts.deriveStayType({ booking_mode: 'nightly', nights_count: 365 })).toBe('contract_stay');
    });
    test('falls back to checkin/checkout date diff when nights_count missing', () => {
      expect(contracts.deriveStayType({
        booking_mode: 'nightly',
        checkin_date: '2026-05-01',
        checkout_date: '2026-08-01',
      })).toBe('contract_stay'); // 92 nights
    });
    test('defaults to nightly when no data available', () => {
      expect(contracts.deriveStayType({ booking_mode: 'nightly' })).toBe('nightly');
    });
  });

  describe('applyTemplate', () => {
    const template = {
      milestones: [
        { label: 'Deposit', percent: 25, trigger: 'signing', due_offset_days: 0 },
        { label: 'Month 1', percent: 25, trigger: 'monthly_on_first', months_after_start: 0 },
        { label: 'Month 2', percent: 25, trigger: 'monthly_on_first', months_after_start: 1 },
        { label: 'Month 3', percent: 25, trigger: 'monthly_on_first', months_after_start: 2 },
      ],
    };

    test('splits total into per-milestone amounts that sum to total', () => {
      const out = contracts.applyTemplate({
        template,
        totalValue: 1000,
        startDate: '2026-05-01',
        endDate: '2026-08-01',
      });
      expect(out.snapshot).toHaveLength(4);
      const sum = out.snapshot.reduce((a, s) => a + Number(s.amount), 0);
      expect(Math.round(sum * 1000) / 1000).toBe(1000);
    });

    test('absorbs residual into last milestone', () => {
      const out = contracts.applyTemplate({
        template: {
          milestones: [
            { label: 'A', percent: 33.333, trigger: 'signing', due_offset_days: 0 },
            { label: 'B', percent: 33.333, trigger: 'signing', due_offset_days: 0 },
            { label: 'C', percent: 33.334, trigger: 'signing', due_offset_days: 0 },
          ],
        },
        totalValue: 100,
        startDate: '2026-05-01',
        endDate: '2026-08-01',
      });
      const sum = out.snapshot.reduce((a, s) => a + Number(s.amount), 0);
      expect(Math.round(sum * 1000) / 1000).toBe(100);
    });

    test('rejects templates whose percents do not sum to 100', () => {
      expect(() => contracts.applyTemplate({
        template: {
          milestones: [{ label: 'A', percent: 50, trigger: 'signing', due_offset_days: 0 }],
        },
        totalValue: 100,
        startDate: '2026-05-01',
        endDate: '2026-08-01',
      })).toThrow(/sum/i);
    });

    test('computes due_dates for each trigger type', () => {
      const out = contracts.applyTemplate({
        template,
        totalValue: 1000,
        startDate: '2026-05-15',
        endDate: '2026-08-15',
        signedAt: '2026-05-10',  // explicit → signing due_date is deterministic
      });
      expect(out.snapshot[0].due_date).toBe('2026-05-10'); // signing day
      expect(out.snapshot[1].due_date).toBe('2026-05-01'); // first of start month
      expect(out.snapshot[2].due_date).toBe('2026-06-01');
      expect(out.snapshot[3].due_date).toBe('2026-07-01');
    });
  });

  describe('computeMilestoneDueDate', () => {
    const ctx = {
      startDate: '2026-05-15',
      endDate:   '2026-08-15',
      signedAt:  '2026-05-10',
    };
    test('signing + offset', () => {
      expect(contracts.computeMilestoneDueDate(
        { trigger: 'signing', due_offset_days: 0 }, ctx
      )).toBe('2026-05-10');
      expect(contracts.computeMilestoneDueDate(
        { trigger: 'signing', due_offset_days: 5 }, ctx
      )).toBe('2026-05-15');
    });
    test('check_in + offset', () => {
      expect(contracts.computeMilestoneDueDate(
        { trigger: 'check_in', due_offset_days: 0 }, ctx
      )).toBe('2026-05-15');
    });
    test('mid_stay splits the window', () => {
      // 2026-05-15 to 2026-08-15 → midpoint ~ 2026-06-30
      const out = contracts.computeMilestoneDueDate(
        { trigger: 'mid_stay', due_offset_days: 0 }, ctx
      );
      expect(out).toMatch(/^2026-06-3[0-9]$|^2026-07-01$/);
    });
    test('monthly_on_first rolls to 1st of month', () => {
      expect(contracts.computeMilestoneDueDate(
        { trigger: 'monthly_on_first', months_after_start: 0 }, ctx
      )).toBe('2026-05-01');
      expect(contracts.computeMilestoneDueDate(
        { trigger: 'monthly_on_first', months_after_start: 3 }, ctx
      )).toBe('2026-08-01');
    });
    test('unknown trigger throws', () => {
      expect(() => contracts.computeMilestoneDueDate(
        { trigger: 'wut', due_offset_days: 0 }, ctx
      )).toThrow(/unknown trigger/i);
    });
  });

  describe('roundMinor', () => {
    test('rounds to 3 decimals', () => {
      expect(contracts.roundMinor(1.2345)).toBe(1.235);
      expect(contracts.roundMinor(1.2344)).toBe(1.234);
      expect(contracts.roundMinor(100)).toBe(100);
    });
  });

  describe('generateContractNumber', () => {
    test('generates YYYY-padded sequence starting at 0001', async () => {
      const fakeClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] })  // advisory lock
          .mockResolvedValueOnce({ rows: [{ next_seq: 1 }] }),
      };
      const out = await contracts.generateContractNumber(fakeClient, {
        tenantId: 33, tenantPrefix: 'AQB', year: 2026,
      });
      expect(out).toBe('AQB-CON-2026-0001');
      expect(fakeClient.query).toHaveBeenCalledTimes(2);
    });

    test('continues from MAX+1', async () => {
      const fakeClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ next_seq: 42 }] }),
      };
      const out = await contracts.generateContractNumber(fakeClient, {
        tenantId: 33, tenantPrefix: 'AQB', year: 2026,
      });
      expect(out).toBe('AQB-CON-2026-0042');
    });

    test('rejects invalid prefix', async () => {
      const fakeClient = { query: jest.fn() };
      await expect(contracts.generateContractNumber(fakeClient, {
        tenantId: 33, tenantPrefix: 'aqb', year: 2026,
      })).rejects.toThrow(/invalid prefix/i);
    });
  });
});

// ─── routes/paymentScheduleTemplates.js ───────────────────────────────────────

describe('routes/paymentScheduleTemplates', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockConnect.mockReset();
  });

  test('GET / includes tenant rows + platform rows (tenant isolation)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 1, tenant_id: null, name: 'Platform: 3-Month', is_system: true },
      { id: 99, tenant_id: 33,  name: 'Aqaba Custom',     is_system: false },
    ] });
    const router = require('../routes/paymentScheduleTemplates');
    const app = makeApp('/api/payment-schedule-templates', router);
    const res = await request(app).get('/api/payment-schedule-templates');
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(2);
    // Check the WHERE clause isolates tenant
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toMatch(/tenant_id = \$1 OR tenant_id IS NULL/);
  });

  test('POST / rejects milestones that do not sum to 100', async () => {
    const router = require('../routes/paymentScheduleTemplates');
    const app = makeApp('/api/payment-schedule-templates', router);
    const res = await request(app)
      .post('/api/payment-schedule-templates')
      .send({
        name: 'Broken',
        stay_type_scope: 'contract_stay',
        milestones: [
          { label: 'A', percent: 50, trigger: 'signing', due_offset_days: 0 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sum/i);
  });

  test('PATCH /:id rejects editing an is_system row', async () => {
    // First query: SELECT to verify ownership
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 33, is_system: true, stay_type_scope: 'contract_stay' }] });
    const router = require('../routes/paymentScheduleTemplates');
    const app = makeApp('/api/payment-schedule-templates', router);
    const res = await request(app)
      .patch('/api/payment-schedule-templates/1')
      .send({ name: 'Hacked' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot be edited/i);
  });

  test('DELETE /:id refuses platform row', async () => {
    // UPDATE returns 0 rows when is_system=true filter excludes the row
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const router = require('../routes/paymentScheduleTemplates');
    const app = makeApp('/api/payment-schedule-templates', router);
    const res = await request(app).delete('/api/payment-schedule-templates/1');
    expect(res.status).toBe(404);
  });
});

// ─── routes/contracts/* ───────────────────────────────────────────────────────

describe('routes/contracts', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockConnect.mockReset();
  });

  function makeTxClient(responses) {
    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    responses.forEach(r => client.query.mockResolvedValueOnce(r));
    return client;
  }

  test('GET / includes tenant_id in WHERE', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })           // SELECT contracts
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }); // COUNT
    const router = require('../routes/contracts');
    const app = makeApp('/api/contracts', router);
    const res = await request(app).get('/api/contracts');
    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toMatch(/c\.tenant_id = \$1/);
    expect(mockQuery.mock.calls[0][1][0]).toBe(33);
  });

  test('POST / rejects missing customer_id', async () => {
    const router = require('../routes/contracts');
    const app = makeApp('/api/contracts', router);
    const res = await request(app)
      .post('/api/contracts')
      .send({ resource_id: 1, start_date: '2026-05-01', end_date: '2026-08-01',
              monthly_rate: 500, total_value: 1500, currency_code: 'JOD' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer_id/);
  });

  test('POST / rejects end_date <= start_date', async () => {
    const router = require('../routes/contracts');
    const app = makeApp('/api/contracts', router);
    const res = await request(app)
      .post('/api/contracts')
      .send({ customer_id: 1, resource_id: 1,
              start_date: '2026-05-01', end_date: '2026-05-01',
              monthly_rate: 500, total_value: 1500, currency_code: 'JOD' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/end_date/);
  });

  test('POST / creates contract + generates contract_number', async () => {
    const txClient = makeTxClient([
      {},  // BEGIN
      { rows: [{ id: 33, slug: 'aqababooking', contract_number_prefix: 'AQB', currency_code: 'JOD' }] }, // tenant
      { rows: [{ cust_id: 1, res_id: 2 }] }, // customer+resource verification
      { rows: [] }, // advisory lock
      { rows: [{ next_seq: 1 }] }, // MAX seq
      { rows: [{ id: 100, contract_number: 'AQB-CON-2026-0001', status: 'draft', created_at: new Date() }] },
      {}, // COMMIT
    ]);
    mockConnect.mockResolvedValueOnce(txClient);

    const router = require('../routes/contracts');
    const app = makeApp('/api/contracts', router);
    const res = await request(app)
      .post('/api/contracts')
      .send({
        customer_id: 1, resource_id: 2,
        start_date: '2026-05-01', end_date: '2026-08-01',
        monthly_rate: 500, total_value: 1500, currency_code: 'JOD',
      });
    expect(res.status).toBe(201);
    expect(res.body.contract.contract_number).toBe('AQB-CON-2026-0001');
    expect(res.body.contract.status).toBe('draft');
  });

  test('POST / surfaces exclusion constraint as 409', async () => {
    const txClient = {
      query: jest.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 33, slug: 'aqababooking', contract_number_prefix: 'AQB' }] })
        .mockResolvedValueOnce({ rows: [{ cust_id: 1, res_id: 2 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ next_seq: 1 }] })
        .mockRejectedValueOnce(Object.assign(new Error('overlap'), { code: '23P01' })) // INSERT fails
        .mockResolvedValueOnce({}), // ROLLBACK (in the inner catch)
      release: jest.fn(),
    };
    mockConnect.mockResolvedValueOnce(txClient);

    const router = require('../routes/contracts');
    const app = makeApp('/api/contracts', router);
    const res = await request(app)
      .post('/api/contracts')
      .send({
        customer_id: 1, resource_id: 2,
        start_date: '2026-05-01', end_date: '2026-08-01',
        monthly_rate: 500, total_value: 1500, currency_code: 'JOD',
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/overlap/i);
  });

  test('PATCH /:id rejects illegal status transition', async () => {
    const txClient = {
      query: jest.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 100, tenant_id: 33, status: 'completed' }] }) // FOR UPDATE
        .mockResolvedValueOnce({}), // ROLLBACK
      release: jest.fn(),
    };
    mockConnect.mockResolvedValueOnce(txClient);

    const router = require('../routes/contracts');
    const app = makeApp('/api/contracts', router);
    const res = await request(app).patch('/api/contracts/100').send({ status: 'signed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/transition/i);
  });
});
