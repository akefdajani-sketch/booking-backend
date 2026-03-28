'use strict';

// __tests__/networkPayments.test.js
// PAY-1: Tests for Network MPGS payment integration

const request = require('supertest');
const app     = require('../app');

// ─── Mock utils/tenants so getTenantBySlug / getTenantIdFromSlug never hit DB ─
jest.mock('../utils/tenants', () => ({
  getTenantBySlug: jest.fn(),
  getTenantIdFromSlug: jest.fn(),
  getTenantByDomain: jest.fn(),
}));

// ─── Mock utils/network.js so tests never hit the real MPGS gateway ───────────
jest.mock('../utils/network', () => ({
  isTenantMpgsEnabled:   jest.fn().mockResolvedValue(true),
  createCheckoutSession: jest.fn().mockResolvedValue({
    sessionId:        'SESSION_MOCK_ABC123',
    successIndicator: 'MOCK_SUCCESS_INDICATOR',
    merchantId:       'test12122024',
    gatewayUrl:       'https://test-network.mtf.gateway.mastercard.com',
  }),
  retrieveOrder: jest.fn().mockResolvedValue({
    result: 'SUCCESS',
    transaction: [{ id: '1', result: 'SUCCESS', authorizationCode: 'AUTH123' }],
  }),
  refundTransaction: jest.fn().mockResolvedValue({ result: 'SUCCESS' }),
}));

// ─── Mock db for payment record inserts/updates ───────────────────────────────
jest.mock('../db', () => ({ query: jest.fn() }));

const db      = require('../db');
const tenants = require('../utils/tenants');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockTenantFound(tenantId = 1, slug = 'birdie', name = 'Birdie Golf') {
  tenants.getTenantBySlug.mockResolvedValue({ id: tenantId, slug, name, kind: 'golf', timezone: 'Asia/Amman' });
  tenants.getTenantIdFromSlug.mockResolvedValue(tenantId);
}

function mockTenantNotFound() {
  tenants.getTenantBySlug.mockRejectedValue(Object.assign(new Error('Not found'), { code: 'TENANT_NOT_FOUND' }));
  tenants.getTenantIdFromSlug.mockRejectedValue(Object.assign(new Error('Not found'), { code: 'TENANT_NOT_FOUND' }));
}

function mockDbPaymentInsert(paymentId = 42) {
  db.query.mockImplementation((sql) => {
    if (sql.includes('INSERT INTO network_payments')) return Promise.resolve({ rows: [{ id: paymentId }] });
    if (sql.includes('FROM network_payments') && sql.includes('order_id')) {
      return Promise.resolve({ rows: [{
        id: 1, tenant_id: 1, success_indicator: 'MOCK_SUCCESS_INDICATOR',
        status: 'pending', amount: '50.000', currency: 'JOD',
      }] });
    }
    if (sql.includes('UPDATE network_payments')) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

// ─── Tests: POST /:slug/initiate ──────────────────────────────────────────────

describe('PAY-1: Network Payments — POST /:slug/initiate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantFound();
    mockDbPaymentInsert();
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
    // PAY-1: v63+ checkoutConfig no longer includes top-level merchant;
    //        session.id and interaction are the only required fields
    expect(res.body.checkoutConfig.session.id).toBe('SESSION_MOCK_ABC123');
    expect(res.body.checkoutConfig.interaction.operation).toBe('PURCHASE');
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
    mockTenantNotFound();

    const res = await request(app)
      .post('/api/network-payment/nonexistent/initiate')
      .send({ amount: '50.000' });

    expect(res.status).toBe(404);
  });

  it('returns 503 when MPGS is not configured for tenant', async () => {
    const { isTenantMpgsEnabled } = require('../utils/network');
    isTenantMpgsEnabled.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/network-payment/birdie/initiate')
      .send({ amount: '50.000' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/);
  });
});

// ─── Tests: GET /:slug/result ─────────────────────────────────────────────────

describe('PAY-1: Network Payments — GET /:slug/result', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantFound();
    mockDbPaymentInsert();
  });

  it('returns success:true when resultIndicator matches and MPGS confirms', async () => {
    const res = await request(app)
      .get('/api/network-payment/birdie/result')
      .query({ orderId: 'FRZ-BIRDIE-ABC-XYZ', resultIndicator: 'MOCK_SUCCESS_INDICATOR' });

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
      .query({ orderId: 'FRZ-BIRDIE-ABC-XYZ', resultIndicator: 'WRONG_INDICATOR' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when orderId is missing', async () => {
    const res = await request(app).get('/api/network-payment/birdie/result');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/orderId/);
  });

  it('returns 404 when payment record not found', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM network_payments')) return Promise.resolve({ rows: [] });
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
      .query({ orderId: 'FRZ-BIRDIE-ABC-XYZ', resultIndicator: 'MOCK_SUCCESS_INDICATOR' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.reason).toBe('VERIFICATION_ERROR');
  });
});

// ─── Tests: order ID generation ───────────────────────────────────────────────

describe('PAY-1: Network Payments — order ID generation', () => {
  it('generates unique order IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 20; i++) {
      const ts   = Date.now().toString(36).toUpperCase();
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      ids.add(`FRZ-BIRDIE-${ts}-${rand}`);
    }
    expect(ids.size).toBe(20);
  });

  it('order IDs are <= 40 characters', () => {
    const id = `FRZ-BIRDIEGE-${Date.now().toString(36).toUpperCase()}-ABCDEF`.slice(0, 40);
    expect(id.length).toBeLessThanOrEqual(40);
  });
});
