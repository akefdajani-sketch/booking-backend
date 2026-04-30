'use strict';

// __tests__/contractS3d.test.js
// G2a-S3d: Tests for routes/contracts/renew.js,
//          utils/contractInvoiceReminderEngine.js,
//          utils/contractInvoiceWhatsapp.js,
//          routes/contractInvoiceReminderJob.js

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
jest.mock('../middleware/requireTenant', () => ({
  requireTenant: (req, res, next) => {
    req.tenantId = Number(req.headers['x-test-tenant-id'] || 33);
    req.tenantSlug = req.headers['x-test-tenant-slug'] || 'aqababooking';
    next();
  },
}));
jest.mock('../middleware/requireAdminOrTenantRole', () => () => (req, res, next) => next());

jest.mock('../utils/contracts', () => ({
  generateContractNumber: jest.fn(async () => 'AQB-CON-2027-0005'),
  resolveContractPrefix: jest.fn(() => 'AQB'),
  applyTemplate: jest.fn(({ totalValue }) => ({
    snapshot: [
      { milestone_index: 0, label: 'Deposit', percent: 25, amount: totalValue * 0.25, due_date: '2027-05-01' },
      { milestone_index: 1, label: 'Month 1', percent: 25, amount: totalValue * 0.25, due_date: '2027-06-01' },
      { milestone_index: 2, label: 'Month 2', percent: 25, amount: totalValue * 0.25, due_date: '2027-07-01' },
      { milestone_index: 3, label: 'Month 3', percent: 25, amount: totalValue * 0.25, due_date: '2027-08-01' },
    ],
  })),
  roundMinor: (n) => Math.round(n * 1000) / 1000,
}));

// Reminder engine mocks
const mockHasFeature = jest.fn();
jest.mock('../utils/entitlements', () => ({
  hasFeature: (...a) => mockHasFeature(...a),
}));

const mockIsWhatsAppEnabledForTenant = jest.fn();
jest.mock('../utils/whatsappCredentials', () => ({
  isWhatsAppEnabledForTenant: (...a) => mockIsWhatsAppEnabledForTenant(...a),
}));

const mockSendMessage = jest.fn();
jest.mock('../utils/whatsapp', () => ({
  sendMessage: (...a) => mockSendMessage(...a),
}));

// G2-PL-4 additions: engine now also dispatches SMS, builds payment links,
// and gates SMS via notificationGates.shouldSendSMS.
const mockShouldSendSMS = jest.fn();
jest.mock('../utils/notificationGates', () => ({
  shouldSendSMS: (...a) => mockShouldSendSMS(...a),
}));

const mockGetOrCreatePendingLink = jest.fn();
jest.mock('../utils/contractInvoicePaymentLinks', () => ({
  getOrCreatePendingLink: (...a) => mockGetOrCreatePendingLink(...a),
}));

const mockTwilioSendMessage = jest.fn();
jest.mock('../utils/twilioSms', () => ({
  sendMessage: (...a) => mockTwilioSendMessage(...a),
  // Re-export the real builders/helpers since our SMS template file requires them
  formatAmount: jest.requireActual('../utils/twilioSms').formatAmount,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRenewApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  require('../routes/contracts/renew')(router);
  app.use('/api/contracts', router);
  return app;
}

function makeClient() {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };
  mockConnect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockConnect.mockReset();
  mockHasFeature.mockReset();
  mockIsWhatsAppEnabledForTenant.mockReset();
  mockSendMessage.mockReset();
  // G2-PL-4 additions
  mockShouldSendSMS.mockReset();
  mockGetOrCreatePendingLink.mockReset();
  mockTwilioSendMessage.mockReset();

  // Sensible defaults — tests can override
  mockShouldSendSMS.mockResolvedValue({ ok: false, reason: 'default_off' });
  mockGetOrCreatePendingLink.mockResolvedValue({ token: 'test-token-abc' });
  mockTwilioSendMessage.mockResolvedValue({ ok: true, messageSid: 'SM-test' });
});

// ─── renew.js ─────────────────────────────────────────────────────────────────

describe('POST /api/contracts/:id/renew', () => {
  test('400 when id is non-numeric', async () => {
    const app = buildRenewApp();
    const res = await request(app).post('/api/contracts/abc/renew').send({
      start_date: '2027-05-01', end_date: '2028-05-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid contract id.');
  });

  test('400 when start_date or end_date missing', async () => {
    const app = buildRenewApp();
    const res = await request(app).post('/api/contracts/42/renew').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('start_date and end_date required');
  });

  test('400 when end_date <= start_date', async () => {
    const app = buildRenewApp();
    const res = await request(app).post('/api/contracts/42/renew').send({
      start_date: '2027-05-01', end_date: '2027-05-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('end_date must be after start_date');
  });

  test('404 when parent contract not found', async () => {
    const client = makeClient();
    client.query.mockResolvedValueOnce({});                  // BEGIN
    client.query.mockResolvedValueOnce({ rows: [] });        // SELECT parent - empty
    client.query.mockResolvedValueOnce({});                  // ROLLBACK

    const app = buildRenewApp();
    const res = await request(app).post('/api/contracts/42/renew').send({
      start_date: '2027-05-01', end_date: '2028-05-01',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Parent contract not found');
  });

  test('400 when start_date not after parent.end_date', async () => {
    const client = makeClient();
    client.query.mockResolvedValueOnce({});                  // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [{
        id: 42, tenant_id: 33, contract_number: 'AQB-CON-2026-0001',
        customer_id: 99, resource_id: 7,
        monthly_rate: 500, total_value: 1500, security_deposit: 500,
        currency_code: 'JOD',
        end_date: '2027-05-01',
        payment_schedule_template_id: null,
      }],
    });
    client.query.mockResolvedValueOnce({});                  // ROLLBACK

    const app = buildRenewApp();
    const res = await request(app).post('/api/contracts/42/renew').send({
      start_date: '2027-04-15', // before parent end
      end_date: '2027-12-31',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must be after the parent');
    expect(res.body.parent_end_date).toBe('2027-05-01');
  });

  test('happy path: renewal copies customer/resource, creates draft with parent link', async () => {
    const client = makeClient();
    client.query.mockResolvedValueOnce({});                  // BEGIN
    client.query.mockResolvedValueOnce({                     // SELECT parent
      rows: [{
        id: 42, tenant_id: 33, contract_number: 'AQB-CON-2026-0001',
        customer_id: 99, resource_id: 7,
        monthly_rate: 500, total_value: 1500, security_deposit: 500,
        currency_code: 'JOD',
        end_date: '2027-04-30',
        payment_schedule_template_id: 3,
        terms: 'Original terms',
        auto_release_on_expiry: false,
      }],
    });
    client.query.mockResolvedValueOnce({                     // SELECT tenant
      rows: [{ slug: 'aqababooking', contract_number_prefix: 'AQB' }],
    });
    client.query.mockResolvedValueOnce({                     // SELECT template
      rows: [{
        id: 3,
        milestones: [
          { label: 'Deposit', percent: 25, trigger: 'signing' },
          { label: 'Month 1', percent: 25, trigger: 'monthly_on_first', months_after_start: 0 },
          { label: 'Month 2', percent: 25, trigger: 'monthly_on_first', months_after_start: 1 },
          { label: 'Month 3', percent: 25, trigger: 'monthly_on_first', months_after_start: 2 },
        ],
        active: true,
      }],
    });
    client.query.mockResolvedValueOnce({                     // INSERT contract
      rows: [{
        id: 101, tenant_id: 33, contract_number: 'AQB-CON-2027-0005',
        parent_contract_id: 42,
        customer_id: 99, resource_id: 7,
        start_date: '2027-05-01', end_date: '2028-05-01',
        monthly_rate: 500, total_value: 6000, security_deposit: 500,
        currency_code: 'JOD', status: 'draft',
      }],
    });
    client.query.mockResolvedValueOnce({});                  // COMMIT

    const app = buildRenewApp();
    const res = await request(app).post('/api/contracts/42/renew').send({
      start_date: '2027-05-01',
      end_date: '2028-05-01',
    });

    expect(res.status).toBe(201);
    expect(res.body.contract.parent_contract_id).toBe(42);
    expect(res.body.contract.status).toBe('draft');
    expect(res.body.contract.contract_number).toBe('AQB-CON-2027-0005');
    expect(res.body.parent_id).toBe(42);

    // Verify INSERT param shape: parent_contract_id at index 2, customer_id idx 3, resource_id idx 4
    const insertCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO contracts'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][2]).toBe(42);
    expect(insertCall[1][3]).toBe(99);
    expect(insertCall[1][4]).toBe(7);
  });

  test('happy path with no template — skips snapshot computation', async () => {
    const client = makeClient();
    client.query.mockResolvedValueOnce({});                  // BEGIN
    client.query.mockResolvedValueOnce({                     // SELECT parent - no template
      rows: [{
        id: 42, tenant_id: 33, contract_number: 'AQB-CON-2026-0001',
        customer_id: 99, resource_id: 7,
        monthly_rate: 500, total_value: 1500, security_deposit: 500,
        currency_code: 'JOD',
        end_date: '2027-04-30',
        payment_schedule_template_id: null,
      }],
    });
    client.query.mockResolvedValueOnce({                     // SELECT tenant
      rows: [{ slug: 'aqababooking' }],
    });
    client.query.mockResolvedValueOnce({                     // INSERT contract
      rows: [{ id: 101, tenant_id: 33, parent_contract_id: 42, status: 'draft' }],
    });
    client.query.mockResolvedValueOnce({});                  // COMMIT

    const app = buildRenewApp();
    const res = await request(app).post('/api/contracts/42/renew').send({
      start_date: '2027-05-01',
      end_date: '2028-05-01',
    });

    expect(res.status).toBe(201);
    // Verify INSERT snapshot param (index 12) is null
    const insertCall = client.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO contracts'),
    );
    expect(insertCall[1][12]).toBeNull();
  });
});

// ─── utils/contractInvoiceWhatsapp ────────────────────────────────────────────

describe('buildContractInvoiceReminderMessage', () => {
  const { buildContractInvoiceReminderMessage, formatAmount } = require('../utils/contractInvoiceWhatsapp');

  test('includes all key fields', () => {
    const msg = buildContractInvoiceReminderMessage({
      tenantName: 'Aqaba Book',
      customerName: 'John Doe',
      contractNumber: 'AQB-CON-2026-0001',
      milestoneLabel: 'Month 2',
      amount: 375.000,
      currency: 'JOD',
      dueDate: '2026-06-01',
    });
    expect(msg).toContain('Aqaba Book');
    expect(msg).toContain('John');
    expect(msg).toContain('AQB-CON-2026-0001');
    expect(msg).toContain('Month 2');
    expect(msg).toContain('JOD 375.000');
    expect(msg).toMatch(/1 Jun 2026/);
  });

  test('formatAmount renders 3 decimals with comma separators', () => {
    expect(formatAmount(1500, 'JOD')).toBe('JOD 1,500.000');
    expect(formatAmount(500.5, 'JOD')).toBe('JOD 500.500');
  });

  test('handles missing customer name gracefully', () => {
    const msg = buildContractInvoiceReminderMessage({
      tenantName: 'X',
      customerName: '',
      contractNumber: 'X-1',
      milestoneLabel: 'M1',
      amount: 100,
      currency: 'JOD',
      dueDate: '2026-06-01',
    });
    expect(msg).toMatch(/^Reminder from X/);
    expect(msg).toContain('Hi,');
  });
});

// ─── reminder engine ─────────────────────────────────────────────────────────
//
// G2-PL-4: engine now runs THREE windows (T-3, due, overdue) per invocation,
// each issuing its own SELECT. New return shape:
//   { elapsedMs, windows: { t3, due, overdue }, totals }
// Each window's stats: { window, processed, waSent, smsSent, anySent, skipped, failed }
// `totals` is an aggregated rollup of all three windows.

describe('runContractInvoiceReminderEngine', () => {
  const { runContractInvoiceReminderEngine } = require('../utils/contractInvoiceReminderEngine');

  // Helper: a sample invoice row matching the engine's SELECT projection
  const sampleRow = (overrides = {}) => ({
    invoice_id: 10, tenant_id: 33, contract_id: 1,
    milestone_index: 0, milestone_label: 'Month 1',
    amount: 500, due_date: '2026-06-01', status: 'sent',
    contract_number: 'AQB-CON-2026-0001', currency_code: 'JOD',
    customer_id: 99, customer_name: 'John', customer_phone: '+962771234567',
    tenant_name: 'Aqaba Book', tenant_timezone: 'Asia/Amman',
    rental_mode_enabled: true,
    ...overrides,
  });

  test('returns zero counts when no rows match in any window', async () => {
    // Three windows = three SELECTs, each empty
    mockQuery.mockResolvedValueOnce({ rows: [] }); // t3
    mockQuery.mockResolvedValueOnce({ rows: [] }); // due
    mockQuery.mockResolvedValueOnce({ rows: [] }); // overdue

    const out = await runContractInvoiceReminderEngine();
    expect(out.totals.processed).toBe(0);
    expect(out.totals.anySent).toBe(0);
    expect(out.totals.skipped).toBe(0);
    expect(out.totals.failed).toBe(0);
  });

  test('skips when feature not enabled and SMS gate is off (both channels gated)', async () => {
    // T-3 window has 1 invoice; other windows empty
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow()] }); // t3 SELECT
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });         // dedup UPDATE for skip
    mockQuery.mockResolvedValueOnce({ rows: [] }); // due
    mockQuery.mockResolvedValueOnce({ rows: [] }); // overdue

    mockHasFeature.mockResolvedValue(false);
    mockShouldSendSMS.mockResolvedValue({ ok: false });

    const out = await runContractInvoiceReminderEngine();
    expect(out.totals.processed).toBe(1);
    expect(out.totals.anySent).toBe(0);
    expect(out.totals.skipped).toBe(1);
    // Neither real WA nor real SMS dispatch should have been called
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockTwilioSendMessage).not.toHaveBeenCalled();
  });

  test('skips when WhatsApp creds not configured AND SMS gate off', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow()] }); // t3 SELECT
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });         // dedup UPDATE for skip
    mockQuery.mockResolvedValueOnce({ rows: [] }); // due
    mockQuery.mockResolvedValueOnce({ rows: [] }); // overdue

    mockHasFeature.mockResolvedValue(true);
    mockIsWhatsAppEnabledForTenant.mockResolvedValue(false);
    mockShouldSendSMS.mockResolvedValue({ ok: false });

    const out = await runContractInvoiceReminderEngine();
    expect(out.totals.skipped).toBe(1);
    expect(out.totals.anySent).toBe(0);
  });

  test('sends WA reminder + stamps reminder_t3_sent_at on success', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow()] }); // t3 SELECT
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });         // dedup UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [] }); // due
    mockQuery.mockResolvedValueOnce({ rows: [] }); // overdue

    mockHasFeature.mockResolvedValue(true);
    mockIsWhatsAppEnabledForTenant.mockResolvedValue(true);
    mockSendMessage.mockResolvedValue({ ok: true, messageId: 'wamid.x' });
    mockShouldSendSMS.mockResolvedValue({ ok: false }); // SMS off — only WA fires

    const out = await runContractInvoiceReminderEngine();
    expect(out.totals.anySent).toBe(1);
    expect(out.totals.failed).toBe(0);
    expect(out.windows.t3.waSent).toBe(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    // Assert UPDATE stamps reminder_t3_sent_at on the right invoice
    const stamp = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' &&
             c[0].includes('UPDATE contract_invoices') &&
             c[0].includes('reminder_t3_sent_at'),
    );
    expect(stamp).toBeDefined();
    expect(stamp[1][0]).toBe(10);
  });

  test('counts failures without stamping when both channels fail', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow()] }); // t3 SELECT
    // No dedup UPDATE expected (both channels failed)
    mockQuery.mockResolvedValueOnce({ rows: [] }); // due
    mockQuery.mockResolvedValueOnce({ rows: [] }); // overdue

    mockHasFeature.mockResolvedValue(true);
    mockIsWhatsAppEnabledForTenant.mockResolvedValue(true);
    mockSendMessage.mockResolvedValue({ ok: false, reason: 'invalid_phone' });
    mockShouldSendSMS.mockResolvedValue({ ok: true });
    mockTwilioSendMessage.mockResolvedValue({ ok: false, reason: 'twilio_error' });

    const out = await runContractInvoiceReminderEngine();
    expect(out.totals.anySent).toBe(0);
    expect(out.totals.failed).toBe(1);

    const stamp = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE contract_invoices'),
    );
    expect(stamp).toBeUndefined();
  });

  test('SMS-only path: WA disabled, SMS succeeds, flag still stamps', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow()] }); // t3 SELECT
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });         // dedup UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [] }); // due
    mockQuery.mockResolvedValueOnce({ rows: [] }); // overdue

    mockHasFeature.mockResolvedValue(false); // WA off
    mockShouldSendSMS.mockResolvedValue({ ok: true });
    mockTwilioSendMessage.mockResolvedValue({ ok: true, messageSid: 'SM-x' });

    const out = await runContractInvoiceReminderEngine();
    expect(out.totals.anySent).toBe(1);
    expect(out.windows.t3.smsSent).toBe(1);
    expect(out.windows.t3.waSent).toBe(0);
    expect(mockTwilioSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('embeds payment URL in WA message body when link is generated', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow()] }); // t3 SELECT
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });         // dedup UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [] }); // due
    mockQuery.mockResolvedValueOnce({ rows: [] }); // overdue

    mockHasFeature.mockResolvedValue(true);
    mockIsWhatsAppEnabledForTenant.mockResolvedValue(true);
    mockSendMessage.mockResolvedValue({ ok: true, messageId: 'wa-x' });
    mockShouldSendSMS.mockResolvedValue({ ok: false });
    mockGetOrCreatePendingLink.mockResolvedValue({ token: 'PAY-TOKEN-XYZ' });

    await runContractInvoiceReminderEngine();
    const waCall = mockSendMessage.mock.calls[0][0];
    expect(waCall.message).toContain('PAY-TOKEN-XYZ');
    expect(waCall.message).toContain('pay-invoice');
  });
});

// ─── cron HTTP endpoint ──────────────────────────────────────────────────────

describe('POST /api/contract-invoice-reminder-job', () => {
  const ORIGINAL_ENV = process.env.CONTRACT_REMINDER_JOB_SECRET;

  afterEach(() => {
    process.env.CONTRACT_REMINDER_JOB_SECRET = ORIGINAL_ENV;
    jest.resetModules();
  });

  test('503 when secret env var not set', async () => {
    delete process.env.CONTRACT_REMINDER_JOB_SECRET;
    jest.resetModules();

    const app = express();
    app.use(express.json());
    app.use('/api/contract-invoice-reminder-job', require('../routes/contractInvoiceReminderJob'));

    const res = await request(app).post('/api/contract-invoice-reminder-job');
    expect(res.status).toBe(503);
  });

  test('401 when secret header missing or wrong', async () => {
    process.env.CONTRACT_REMINDER_JOB_SECRET = 'shh';
    jest.resetModules();

    const app = express();
    app.use(express.json());
    app.use('/api/contract-invoice-reminder-job', require('../routes/contractInvoiceReminderJob'));

    const resMissing = await request(app).post('/api/contract-invoice-reminder-job');
    expect(resMissing.status).toBe(401);

    const resWrong = await request(app)
      .post('/api/contract-invoice-reminder-job')
      .set('x-contract-reminder-secret', 'wrong');
    expect(resWrong.status).toBe(401);
  });
});
