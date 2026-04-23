'use strict';

// __tests__/contractInvoices.test.js
// G2a-2: Tests for routes/contracts/pdf.js, routes/contracts/invoices.js,
//        and utils/contractWebhookHandler.js

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
jest.mock('../db', () => ({
  pool: { query: mockQuery, connect: jest.fn(), on: jest.fn() },
  query: mockQuery,
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), error: jest.fn() })),
}));

// Mock the PDF generator so we don't hit pdfkit + r2 in these tests
const mockGenerate = jest.fn();
jest.mock('../utils/contractPdf', () => ({
  generateContractPdf: (...args) => mockGenerate(...args),
}));

// Mock r2 (only deleteFromR2 is called directly by pdf route)
jest.mock('../utils/r2', () => ({
  deleteFromR2: jest.fn(async () => {}),
  uploadFileToR2: jest.fn(),
  publicUrlForKey: jest.fn(),
  extractKeyFromPublicUrl: jest.fn(),
  sanitizeEndpoint: jest.fn(),
  safeName: jest.fn(),
}));

// Mock taxEngine
jest.mock('../utils/taxEngine', () => ({
  loadTenantTaxConfig: jest.fn(async () => ({ vat_rate: 16, vat_label: 'VAT', tax_inclusive: false })),
}));

// Mock stripeInvoicing (used by routes/contracts/invoices.js)
const mockCreateStripe = jest.fn();
const mockPaidOOB      = jest.fn();
jest.mock('../utils/stripeInvoicing', () => ({
  createStripeInvoiceForMilestone: (...a) => mockCreateStripe(...a),
  markStripeInvoicePaidOutOfBand:  (...a) => mockPaidOOB(...a),
  ensureStripeTaxRate:             jest.fn(),
  ensureStripeCustomer:            jest.fn(),
  voidStripeInvoice:               jest.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApp(path, router, attachTenantId = 33) {
  const app = express();
  app.use(express.json());
  // Inject req.user
  app.use((req, res, next) => {
    req.user = { tenant_id: attachTenantId };
    next();
  });
  app.use(path, router);
  return app;
}

function buildPdfApp(tenantId = 33) {
  const express2 = require('express');
  const router = express2.Router();
  require('../routes/contracts/pdf')(router);
  return makeApp('/api/contracts', router, tenantId);
}

function buildInvoicesApp(tenantId = 33) {
  const express2 = require('express');
  const router = express2.Router();
  require('../routes/contracts/invoices')(router);
  return makeApp('/api/contracts', router, tenantId);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

// ─── POST /:id/generate-pdf ──────────────────────────────────────────────────

describe('POST /api/contracts/:id/generate-pdf', () => {
  test('400 on non-integer id', async () => {
    const app = buildPdfApp();
    const res = await request(app).post('/api/contracts/abc/generate-pdf');
    expect(res.status).toBe(400);
  });

  test('401 when no tenant_id on user', async () => {
    const app = buildPdfApp(0);
    const res = await request(app).post('/api/contracts/1/generate-pdf');
    expect(res.status).toBe(401);
  });

  test('404 when contract not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });  // SELECT contract
    const app = buildPdfApp();
    const res = await request(app).post('/api/contracts/1/generate-pdf');
    expect(res.status).toBe(404);
  });

  test('409 when status=signed (pdf locked)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'signed', customer_id: 99, resource_id: 7 }],
    });
    const app = buildPdfApp();
    const res = await request(app).post('/api/contracts/1/generate-pdf');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('pdf_locked');
  });

  test('409 when status=active', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'active', customer_id: 99, resource_id: 7 }],
    });
    const app = buildPdfApp();
    const res = await request(app).post('/api/contracts/1/generate-pdf');
    expect(res.status).toBe(409);
  });

  test('happy path: draft contract → generates + persists', async () => {
    // 1. SELECT contract
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1, tenant_id: 33, status: 'draft',
        customer_id: 99, resource_id: 7,
        contract_number: 'AQB-CON-2026-0001',
        payment_schedule_snapshot: [{ label: 'Deposit', amount: 500, due_date: '2026-05-01' }],
        generated_pdf_key: null,
      }],
    });
    // 2. Parallel: SELECT tenants / customers / resources
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33, name: 'Aqaba Book', slug: 'aqababooking' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99, name: 'John Doe', tenant_id: 33 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: 'Suite 301', tenant_id: 33 }] });
    // 3. UPDATE contracts
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    mockGenerate.mockResolvedValue({
      url: 'https://r2.example.com/contracts/33/AQB-CON-2026-0001_123.pdf',
      key: 'contracts/33/AQB-CON-2026-0001_123.pdf',
      hash: 'abc123def456',
    });

    const app = buildPdfApp();
    const res = await request(app).post('/api/contracts/1/generate-pdf');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toContain('AQB-CON-2026-0001');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    // The UPDATE should have been called with url, key, hash
    const updateCall = mockQuery.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('UPDATE contracts'));
    expect(updateCall).toBeDefined();
    expect(updateCall[1].slice(0, 3)).toEqual([
      'https://r2.example.com/contracts/33/AQB-CON-2026-0001_123.pdf',
      'contracts/33/AQB-CON-2026-0001_123.pdf',
      'abc123def456',
    ]);
  });

  test('422 when customer missing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'draft', customer_id: 99, resource_id: 7,
               payment_schedule_snapshot: [] }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33, name: 'T' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // customer missing
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: 'R' }] });

    const app = buildPdfApp();
    const res = await request(app).post('/api/contracts/1/generate-pdf');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('customer missing');
  });

  test('tenant isolation: contract owned by different tenant → 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT returned nothing because WHERE tenant_id=33
    const app = buildPdfApp(33);
    const res = await request(app).post('/api/contracts/1/generate-pdf');
    expect(res.status).toBe(404);
  });
});

// ─── POST /:id/invoices/:i/send-invoice ──────────────────────────────────────

describe('POST /api/contracts/:id/invoices/:milestoneIndex/send-invoice', () => {
  test('400 on non-integer milestone index', async () => {
    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/abc/send-invoice');
    expect(res.status).toBe(400);
  });

  test('404 when contract missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/send-invoice');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contract not found');
  });

  test('404 when milestone invoice row missing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'active', customer_id: 99,
               contract_number: 'AQB-CON-2026-0001', currency_code: 'JOD' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // contract_invoices

    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/send-invoice');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invoice not found');
  });

  test('409 when contract status is draft', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'draft', customer_id: 99 }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, tenant_id: 33, contract_id: 1, milestone_index: 0,
               amount: 500, status: 'pending' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99, name: 'John' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33, name: 'Aqaba Book' }] });

    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/send-invoice');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contract_not_active');
  });

  test('409 when invoice already sent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'active', customer_id: 99 }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, tenant_id: 33, contract_id: 1, milestone_index: 0,
               amount: 500, status: 'sent', stripe_invoice_id: 'in_EXISTING' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99, name: 'John' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33, name: 'Aqaba Book' }] });

    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/send-invoice');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invoice_not_pending');
    expect(res.body.stripe_invoice_id).toBe('in_EXISTING');
  });

  test('happy path: creates Stripe invoice + persists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'active', customer_id: 99,
               contract_number: 'AQB-CON-2026-0001', currency_code: 'JOD' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, tenant_id: 33, contract_id: 1, milestone_index: 0,
               milestone_label: 'Deposit', amount: 500, status: 'pending' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99, name: 'John' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33, name: 'Aqaba Book' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE contract_invoices

    mockCreateStripe.mockResolvedValue({
      stripeInvoiceId: 'in_TEST_123',
      hostedInvoiceUrl: 'https://invoice.stripe.com/test123',
      status: 'sent',
    });

    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/send-invoice');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stripe_invoice_id).toBe('in_TEST_123');
    expect(res.body.hosted_invoice_url).toBe('https://invoice.stripe.com/test123');
    expect(mockCreateStripe).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /:id/invoices/:i/mark-paid ─────────────────────────────────────────

describe('POST /api/contracts/:id/invoices/:milestoneIndex/mark-paid', () => {
  test('400 when payment_method missing', async () => {
    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/mark-paid').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('invalid payment_method');
  });

  test('400 when payment_method invalid', async () => {
    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/mark-paid')
      .send({ payment_method: 'bitcoin' });
    expect(res.status).toBe(400);
  });

  test('400 when paid_at is invalid date', async () => {
    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/mark-paid')
      .send({ payment_method: 'cash', paid_at: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid paid_at');
  });

  test('409 when invoice already paid', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'active', customer_id: 99 }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, tenant_id: 33, contract_id: 1, milestone_index: 0,
               amount: 500, status: 'paid', paid_at: '2026-04-01' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33 }] });

    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/mark-paid')
      .send({ payment_method: 'cash' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_paid');
  });

  test('409 when invoice cancelled', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'active' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, status: 'cancelled', amount: 500 }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33 }] });

    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/mark-paid')
      .send({ payment_method: 'cash' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invoice_finalized');
  });

  test('happy path cash: sets status=paid + does NOT call Stripe', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'active' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, tenant_id: 33, contract_id: 1, milestone_index: 0,
               amount: 500, status: 'pending', stripe_invoice_id: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33 }] });
    // UPDATE
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, status: 'paid', amount_paid: 500, payment_method: 'cash' }],
    });

    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/mark-paid')
      .send({ payment_method: 'cash', payment_notes: 'Received at office' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.invoice.status).toBe('paid');
    expect(mockPaidOOB).not.toHaveBeenCalled();
  });

  test('calls Stripe paid_out_of_band when stripe_invoice_id exists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tenant_id: 33, status: 'active' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, tenant_id: 33, contract_id: 1, milestone_index: 0,
               amount: 500, status: 'sent', stripe_invoice_id: 'in_TEST_999' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 99 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 33 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, status: 'paid', stripe_invoice_id: 'in_TEST_999' }],
    });
    mockPaidOOB.mockResolvedValue(undefined);

    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/mark-paid')
      .send({ payment_method: 'cliq', payment_ref: 'CLIQ-20260423-001' });

    expect(res.status).toBe(200);
    expect(mockPaidOOB).toHaveBeenCalledWith('in_TEST_999');
  });

  test('rejects all invalid payment methods in allowed list error', async () => {
    const app = buildInvoicesApp();
    const res = await request(app).post('/api/contracts/1/invoices/0/mark-paid')
      .send({ payment_method: 'venmo' });
    expect(res.status).toBe(400);
    expect(res.body.allowed).toEqual(expect.arrayContaining(['cash', 'cliq', 'card', 'stripe', 'other']));
  });
});

// ─── contractWebhookHandler ──────────────────────────────────────────────────

describe('utils/contractWebhookHandler', () => {
  const { handleContractInvoiceEvent } = require('../utils/contractWebhookHandler');

  test('returns false when metadata.flexrz_channel is absent', async () => {
    const stripeInvoice = { id: 'in_1', metadata: { foo: 'bar' } };
    const handled = await handleContractInvoiceEvent('invoice.paid', stripeInvoice);
    expect(handled).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('returns false when metadata is null', async () => {
    const handled = await handleContractInvoiceEvent('invoice.paid', { id: 'in_1' });
    expect(handled).toBe(false);
  });

  test('claims event but logs when metadata.contract_invoice_id invalid', async () => {
    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: 'not-a-number', tenant_id: '33' },
    };
    const handled = await handleContractInvoiceEvent('invoice.paid', stripeInvoice);
    expect(handled).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('claims event + no-op when contract_invoices row missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: '42', tenant_id: '33' },
    };
    const handled = await handleContractInvoiceEvent('invoice.paid', stripeInvoice);
    expect(handled).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the SELECT
  });

  test('invoice.paid marks contract_invoices paid + uses Stripe paid_at timestamp', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: 'sent' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: '42', tenant_id: '33' },
      status_transitions: { paid_at: 1745971200 },  // 2025-04-30 epoch (example)
    };
    const handled = await handleContractInvoiceEvent('invoice.paid', stripeInvoice);
    expect(handled).toBe(true);

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain("status        = 'paid'");
    expect(updateCall[1][0]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO date string
    expect(updateCall[1][1]).toBe(42);
    expect(updateCall[1][2]).toBe(33);
  });

  test('invoice.paid uses current time when status_transitions.paid_at missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: 'sent' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: '42', tenant_id: '33' },
    };
    const handled = await handleContractInvoiceEvent('invoice.paid', stripeInvoice);
    expect(handled).toBe(true);
  });

  test('invoice.payment_failed appends audit note, does not change status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: 'sent' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: '42', tenant_id: '33' },
      last_payment_error: { message: 'Card declined' },
    };
    const handled = await handleContractInvoiceEvent('invoice.payment_failed', stripeInvoice);
    expect(handled).toBe(true);

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain('payment_notes');
    expect(updateCall[1][0]).toBe('Card declined');
  });

  test('invoice.voided sets status=void', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: 'sent' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: '42', tenant_id: '33' },
    };
    const handled = await handleContractInvoiceEvent('invoice.voided', stripeInvoice);
    expect(handled).toBe(true);

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain("status     = 'void'");
  });

  test('invoice.voided does NOT void an already-paid invoice (safety)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: 'paid' }] });

    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: '42', tenant_id: '33' },
    };
    const handled = await handleContractInvoiceEvent('invoice.voided', stripeInvoice);
    expect(handled).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the SELECT, no UPDATE
  });

  test('invoice.finalized is claimed but no-op', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: 'sent' }] });
    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: '42', tenant_id: '33' },
    };
    const handled = await handleContractInvoiceEvent('invoice.finalized', stripeInvoice);
    expect(handled).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('invoice.sent is claimed but no-op', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: 'sent' }] });
    const stripeInvoice = {
      id: 'in_1',
      metadata: { flexrz_channel: 'contract', contract_invoice_id: '42', tenant_id: '33' },
    };
    const handled = await handleContractInvoiceEvent('invoice.sent', stripeInvoice);
    expect(handled).toBe(true);
  });
});
