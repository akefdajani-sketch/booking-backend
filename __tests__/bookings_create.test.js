'use strict';

// __tests__/bookings_create.test.js
//
// PR 0.1 — Test 1: happy-path timeslot booking create.
//
// This is the foundation of the Phase 1 refactor test net for
// routes/bookings/create.js (1680L). It exercises the full request →
// 201 pipeline for a paid timeslot service with no membership, no
// prepaid, and no required confirmation.
//
// Harness forks (documented in the PR description):
//   Fork A — DB layer:      (i) full mock of ../db (transaction-aware).
//   Fork B — Auth:          (i) mock ../middleware/requireAppAuth.
//   Fork C — Notifications: (i) mock notification utils + gates to no-op.
//
// requireTenant is also stubbed directly (sets req.tenantId / req.tenantSlug).
// It stubs cleanly with no DB read, so stop-condition #4 does not apply.

const express = require('express');
const request = require('supertest');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID   = 1;
const TENANT_SLUG = 'test-tenant';
const SERVICE_ID  = 50;
const CUSTOMER_ID = 100;
const SERVICE_PRICE = 25;
const NEW_BOOKING_ID = 9001;

const CUSTOMER_ROW = {
  id: CUSTOMER_ID,
  name: 'Test Customer',
  phone: '+962790000000',
  email: 'customer@example.com',
};

const SERVICE_ROW = {
  id: SERVICE_ID,
  tenant_id: TENANT_ID,
  duration_minutes: 60,
  max_parallel_bookings: 1,
  price_amount: SERVICE_PRICE,
  requires_confirmation: false,
};

// loadJoinedBookingById is mocked; this is the row the handler echoes back.
const JOINED_BOOKING = {
  id: NEW_BOOKING_ID,
  tenant_id: TENANT_ID,
  status: 'confirmed',
  booking_code: 'TST-TS-260516-0079',
  price_amount: SERVICE_PRICE,
  charge_amount: SERVICE_PRICE,
  currency_code: 'JOD',
  customer_id: CUSTOMER_ID,
  customer_name: CUSTOMER_ROW.name,
  customer_phone: CUSTOMER_ROW.phone,
  customer_email: CUSTOMER_ROW.email,
  service_name: 'Test Service',
  start_time: new Date(Date.now() + 86400000).toISOString(),
  payment_method: 'cash',
  payment_status: 'completed',
};

// ─── Mocks (hoisted above the require of create.js) ───────────────────────────

// Fork A — full mock of ../db. A single shared `client` object is returned by
// db.connect() so the test can inspect the BEGIN/INSERT/COMMIT call sequence.
jest.mock('../db', () => {
  const client = { query: jest.fn(), release: jest.fn() };
  const query = jest.fn();
  const connect = jest.fn(async () => client);
  return { pool: { query, connect, on: jest.fn() }, query, connect, __client: client };
});

// Fork B — auth middleware stub. Sets the same req shape requireAppAuth would.
jest.mock('../middleware/requireAppAuth', () => (req, _res, next) => {
  req.auth = { email: 'customer@example.com', name: 'Test Customer' };
  req.googleUser = req.auth;
  next();
});

// requireTenant stub — sets req.tenantId / req.tenantSlug with no DB read.
jest.mock('../middleware/requireTenant', () => ({
  requireTenant: (req, _res, next) => {
    req.tenantId = 1;
    req.tenantSlug = 'test-tenant';
    req.tenant = { id: 1, slug: 'test-tenant' };
    next();
  },
}));

// Schema-guard utils — pretend money / rate / payment_method columns all exist.
jest.mock('../utils/ensureBookingMoneyColumns', () => ({
  ensureBookingMoneyColumns: jest.fn().mockResolvedValue(true),
}));
jest.mock('../utils/ensureBookingRateColumns', () => ({
  ensureBookingRateColumns: jest.fn().mockResolvedValue(true),
}));
jest.mock('../utils/ensurePaymentMethodColumn', () => ({
  ensurePaymentMethodColumn: jest.fn().mockResolvedValue(true),
}));

// utils/bookings — checkConflicts + loadJoinedBookingById drive the pipeline;
// session helpers are unused on the happy path (max_parallel_bookings = 1).
jest.mock('../utils/bookings', () => ({
  findOrCreateSession: jest.fn(),
  incrementSessionCount: jest.fn(),
  decrementSessionCount: jest.fn(),
  checkConflicts: jest.fn(),
  loadJoinedBookingById: jest.fn(),
}));

// utils/bookingRouteHelpers — auto-mock, then pin the handful the happy path hits.
jest.mock('../utils/bookingRouteHelpers');

// Pricing / policy engines.
jest.mock('../utils/ratesEngine', () => ({
  computeRateForBookingLike: jest.fn().mockResolvedValue({
    adjusted_price_amount: null,
    applied_rate_rule_id: null,
    applied_rate_snapshot: null,
  }),
}));
jest.mock('../utils/taxEngine', () => ({
  computeTaxForBooking: jest.fn().mockResolvedValue({
    subtotal: 25,
    vat_amount: 0,
    service_charge_amount: 0,
    total: 25,
    snapshot: null,
  }),
}));
jest.mock('../utils/bookingPolicy', () => ({
  getBookingPolicy: jest.fn().mockResolvedValue({
    enforceWorkingHours: false,
    requireCharge: false,
  }),
  validateWithinWorkingHours: jest.fn(),
  validateRequireCharge: jest.fn(),
}));

// Fork C — notifications. Gates return { ok: false } so the setImmediate
// dispatch callbacks return immediately, before requiring any channel module.
jest.mock('../utils/notificationGates', () => ({
  shouldSendWA: jest.fn().mockResolvedValue({ ok: false }),
  shouldSendSMS: jest.fn().mockResolvedValue({ ok: false }),
  shouldSendEmail: jest.fn().mockResolvedValue({ ok: false }),
}));
jest.mock('../utils/whatsapp', () => ({ sendBookingConfirmation: jest.fn() }));
jest.mock('../utils/twilioSms', () => ({ sendBookingConfirmation: jest.fn() }));
jest.mock('../utils/email', () => ({ sendEmail: jest.fn() }));

jest.mock('../utils/aiContextCache', () => ({ bustCustomer: jest.fn() }));
jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

const db = require('../db');
const helpers = require('../utils/bookingRouteHelpers');
const { checkConflicts, loadJoinedBookingById } = require('../utils/bookings');

// Mount ONLY create.js onto a fresh router (not the full routes/bookings.js,
// which would also load history / crud / confirmPayment).
function buildApp() {
  const router = express.Router();
  require('../routes/bookings/create')(router);
  const app = express();
  app.use(express.json());
  app.use('/api/bookings', router);
  return app;
}

// Flush the post-response setImmediate notification callbacks so Jest does not
// see them as work-after-teardown.
const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));

// ─── DB mock routing ──────────────────────────────────────────────────────────

function installDbMocks() {
  // Pool reads (db.query) — routed by SQL substring (whitespace-normalized,
  // since create.js builds multi-line template-literal SQL).
  db.query.mockImplementation(async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.includes('SELECT branding FROM tenants')) return { rows: [{ branding: {} }] };
    if (s.includes('FROM customers WHERE tenant_id')) return { rows: [CUSTOMER_ROW] };
    if (s.includes("column_name='requires_confirmation'")) return { rowCount: 1, rows: [{}] };
    if (s.includes("'price_amount','price','price_per_night'")) {
      return { rows: [{ column_name: 'price_amount' }] };
    }
    if (s.includes("column_name='currency_code'")) return { rowCount: 1, rows: [{}] };
    if (s.includes('SELECT currency_code FROM tenants')) return { rows: [{ currency_code: 'JOD' }] };
    if (s.includes('FROM services WHERE id=')) return { rows: [SERVICE_ROW] };
    if (s.includes("column_name='payment_status'")) return { rows: [{}] };
    if (s.includes("'subtotal_amount'")) return { rows: [{}, {}, {}, {}, {}] };
    if (s.includes("'booking_mode'")) return { rows: [] };
    if (s.includes('FROM customer_memberships')) return { rows: [] };
    if (s.includes('FROM customer_prepaid_entitlements')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  });

  // Transaction-owning queries (client.query).
  db.__client.query.mockImplementation(async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return {};
    if (s.includes('INSERT INTO bookings')) return { rows: [{ id: NEW_BOOKING_ID }] };
    if (s.includes('UPDATE tenants')) {
      return { rows: [{ booking_seq: 79, booking_code_prefix: 'TST', slug: TENANT_SLUG }] };
    }
    if (s.includes('UPDATE bookings')) return { rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  // Helpers the happy path actually calls.
  helpers.getIdempotencyKey.mockReturnValue(null);
  helpers.checkBlackoutOverlap.mockResolvedValue(null);
  helpers.loadMembershipCheckoutPolicy.mockResolvedValue({});
  helpers.bumpTenantBookingChange.mockResolvedValue(undefined);

  checkConflicts.mockResolvedValue({ conflict: false });
  loadJoinedBookingById.mockResolvedValue({ ...JOINED_BOOKING });
}

beforeEach(() => {
  jest.clearAllMocks();
  installDbMocks();
});

// ─── Test 1 — happy-path timeslot create ──────────────────────────────────────

test('happy path: paid timeslot booking → 201, single INSERT, COMMIT, no ledger writes', async () => {
  const app = buildApp();
  const startTime = new Date(Date.now() + 86400000).toISOString(); // +24h

  const res = await request(app)
    .post('/api/bookings')
    .send({
      tenantSlug: TENANT_SLUG,
      serviceId: SERVICE_ID,
      startTime,
      durationMinutes: 60,
      paymentMethod: 'cash',
    });

  await flushImmediates();

  // ── HTTP contract ──
  expect(res.status).toBe(201);
  expect(res.body.replay).toBe(false);
  expect(res.body.booking).toMatchObject({
    id: NEW_BOOKING_ID,
    status: 'confirmed',
  });
  expect(res.body.tax.total_amount).toBe(SERVICE_PRICE);

  // ── INSERT INTO bookings — called exactly once, with the expected params ──
  const clientCalls = db.__client.query.mock.calls.map((c) => String(c[0]));
  const insertCall = db.__client.query.mock.calls.find((c) =>
    String(c[0]).includes('INSERT INTO bookings'),
  );
  expect(insertCall).toBeDefined();
  expect(clientCalls.filter((s) => s.includes('INSERT INTO bookings'))).toHaveLength(1);

  // Column order (full money + rate + tax branch, create.js L911-958):
  //  [0] tenant_id [1] service_id [2] staff_id [3] resource_id [4] start_time
  //  [5] duration_minutes [6] customer_id [7] customer_name [8] customer_phone
  //  [9] customer_email [10] status [11] idempotency_key [12] customer_membership_id
  //  [13] session_id [14] payment_method [15] payment_status [16] price_amount
  //  [17] charge_amount [18] currency_code ...
  // Index assertions are intentional: the persist.js extraction must preserve
  // this param contract, and this test is the net that proves it.
  const params = insertCall[1];
  expect(params[1]).toBe(SERVICE_ID);          // service_id
  expect(params[6]).toBe(CUSTOMER_ID);         // customer_id
  expect(params[10]).toBe('confirmed');        // status (requires_confirmation = false)
  expect(params[12]).toBeNull();               // customer_membership_id — none applied
  expect(params[13]).toBeNull();               // session_id — single-capacity service
  expect(params[14]).toBe('cash');             // payment_method (PAY-INTENT-1)
  expect(params[15]).toBe('completed');        // payment_status (CLIQ-CONFIRM-1)
  expect(params[16]).toBe(SERVICE_PRICE);      // price_amount === service price
  expect(params[17]).toBe(SERVICE_PRICE);      // charge_amount === service price (no membership/prepaid)

  // ── Booking code — generated in the real format {PREFIX}-{TYPE}-{YYMMDD}-{SEQ4} ──
  const codeUpdate = db.__client.query.mock.calls.find((c) =>
    String(c[0]).includes('UPDATE bookings') && String(c[0]).includes('booking_code'),
  );
  expect(codeUpdate).toBeDefined();
  expect(codeUpdate[1][0]).toMatch(/^[A-Z]{2,5}-TS-\d{6}-\d{4}$/);

  // ── Transaction lifecycle — BEGIN + COMMIT, never ROLLBACK ──
  expect(clientCalls).toContain('BEGIN');
  expect(clientCalls).toContain('COMMIT');
  expect(clientCalls).not.toContain('ROLLBACK');
  expect(db.__client.release).toHaveBeenCalledTimes(1);

  // ── DB state — no membership ledger / prepaid writes ──
  expect(clientCalls.some((s) => s.includes('membership_ledger'))).toBe(false);
  expect(clientCalls.some((s) => s.includes('prepaid_redemptions'))).toBe(false);
  expect(clientCalls.some((s) => s.includes('prepaid_transactions'))).toBe(false);
});
