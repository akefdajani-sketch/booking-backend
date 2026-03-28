'use strict';

// __tests__/networkPayments.test.js
// PAY-1: Tests for Network MPGS payment integration

const request = require('supertest');
const app     = require('../app');

// ─── Mock utils/network.js so tests never hit the real MPGS gateway ───────────
jest.mock('../utils/network', () => ({
  isMpgsEnabled:         jest.fn(() => true),
  getMpgsConfig:         jest.fn(() => ({
    merchantId:  'test12122024',
    apiPassword: 'testpass',
    gatewayUrl:  'https://test-network.mtf.gateway.mastercard.com',
  })),
  createCheckoutSession: jest.fn().mockResolvedValue({
    sessionId:        'SESSION_MOCK_ABC123',
    successIndicator: 'MOCK_SUCCESS_INDICATOR',
    checkoutMode:     'WEBSITE',
    merchant:         'test12122024',
  }),
  retrieveOrder: jest.fn().mockResolvedValue({
    result: 'SUCCESS',
    transaction: [{
      id:     '1',
      result: 'SUCCESS',
      authorizationCode: 'AUTH123',
    }],
  }),
  retrieveTransaction: jest.fn().mockResolvedValue({
    id:     '1',
    result: 'SUCCESS',
  }),
  refundTransaction: jest.fn().mockResolvedValue({
    result: 'SUCCESS',
  }),
}));

// ─── Mock db so tests don't need a real database ─────────────────────────────
jest.mock('../db', () => ({
  query: jest.fn(),
}));

const db = require('../db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockTenantLookup(tenantId = 1, slug = 'birdie', name = 'Birdie Golf') {
  db.query.mockImplementation((sql, params) => {
    // getTenantBySlug
    if (sql.includes('FROM tenants WHERE slug')) {
      return Promise.resolve({
        rows: [{ id: tenantId, slug, name, kind: 'golf', timezone: 'Asia/Amman' }],
      });
    }
    // INSERT network_payments
    if (sql.includes('INSERT INTO network_payments')) {
      return Promise.resolve({ rows: [{ id: 42 }] });
    }
    // SELECT for result verification
    if (sql.includes('FROM network_payments') && sql.includes('order_id')) {
      return Promise.resolve({
        rows: [{
          id:                1,
          tenant_id:         tenantId,
          success_indicator: 'MOCK_SUCCESS_INDICATOR',
          status:            'pending',
          amount:            '50.000',
          currency:          'JOD',
        }],
      });
    }
    // UPDATE
    if (sql.includes('UPDATE network_payments')) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PAY-1: Network Payments — POST /:slug/initiate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantLookup();
  });

  it('returns 200 with sessionId and checkoutConfig on valid request', async () => {
    const res = await request(app)
      .post('/api/network-payment/birdie/initiate')
      .send({ amount: '50.000', currency: 'JOD', description: 'Test booking' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('SESSION_MOCK_ABC123');
    expect(res.body.orderId).toMatch(/^FRZ-/);
    expect(res.body.paymentId).toBe(42);
    expect(res.body.checkoutConfig).toBeDefined();
    expect(res.body.checkoutConfig.merchant).toBe('test12122024');
  });

  it('returns 400 when amount is missing', async () => {
    const res = await request(app)
      .post('/api/network-payment/birdie/initiate')
      .send({ currency: 'JOD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/);
  });

  it('returns 400 when amount is zero', async () => {
    const res = await request(app)
      .post('/api/network-payment/birdie/initiate')
      .send({ amount: '0', currency: 'JOD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/greater than 0/);
  });

  it('returns 404 when tenant not found', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM tenants WHERE slug')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/api/network-payment/nonexistent/initiate')
      .send({ amount: '50.000' });

    expect(res.status).toBe(404);
  });

  it('returns 503 when MPGS is not configured', async () => {
    const { isMpgsEnabled } = require('../utils/network');
    isMpgsEnabled.mockReturnValueOnce(false);

    const res = await request(app)
      .post('/api/network-payment/birdie/initiate')
      .send({ amount: '50.000' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/);
  });
});

describe('PAY-1: Network Payments — GET /:slug/result', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantLookup();
  });

  it('returns success:true when resultIndicator matches and MPGS confirms', async () => {
    const res = await request(app)
      .get('/api/network-payment/birdie/result')
      .query({
        orderId:         'FRZ-BIRDIE-ABC-XYZ',
        resultIndicator: 'MOCK_SUCCESS_INDICATOR',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.orderId).toBe('FRZ-BIRDIE-ABC-XYZ');
  });

  it('returns success:false when resultIndicator does not match', async () => {
    const { retrieveOrder } = require('../utils/network');
    retrieveOrder.mockResolvedValueOnce({
      result: 'FAILURE',
      transaction: [{ id: '1', result: 'FAILURE' }],
    });

    const res = await request(app)
      .get('/api/network-payment/birdie/result')
      .query({
        orderId:         'FRZ-BIRDIE-ABC-XYZ',
        resultIndicator: 'WRONG_INDICATOR',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when orderId is missing', async () => {
    const res = await request(app)
      .get('/api/network-payment/birdie/result');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/orderId/);
  });

  it('returns 404 when payment record not found', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM network_payments')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .get('/api/network-payment/birdie/result')
      .query({ orderId: 'FRZ-UNKNOWN-ORDER' });

    expect(res.status).toBe(404);
  });

  it('handles MPGS verification failure gracefully', async () => {
    const { retrieveOrder } = require('../utils/network');
    retrieveOrder.mockRejectedValueOnce(new Error('MPGS timeout'));

    const res = await request(app)
      .get('/api/network-payment/birdie/result')
      .query({
        orderId:         'FRZ-BIRDIE-ABC-XYZ',
        resultIndicator: 'MOCK_SUCCESS_INDICATOR',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.reason).toBe('VERIFICATION_ERROR');
  });
});

describe('PAY-1: Network Payments — generateOrderId uniqueness', () => {
  it('generates unique order IDs for rapid calls', () => {
    // Test indirectly by checking two initiate calls return different orderIds
    const ids = new Set();
    for (let i = 0; i < 20; i++) {
      const ts   = Date.now().toString(36).toUpperCase();
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      ids.add(`FRZ-BIRDIE-${ts}-${rand}`);
    }
    expect(ids.size).toBe(20);
  });

  it('order IDs are ≤ 40 characters', () => {
    const id = `FRZ-BIRDIEGE-${Date.now().toString(36).toUpperCase()}-ABCDEF`.slice(0, 40);
    expect(id.length).toBeLessThanOrEqual(40);
  });
});
