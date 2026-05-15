'use strict';

// __tests__/bookings_create.test.js
//
// Integration tests for routes/bookings/create.js (1680L).
//   Test 1  (PR 0.1) — happy-path timeslot create.
//   Test 2  (PR 0.2) — membership auto-consume + ledger debit.
//   Test 4  (PR 0.2) — idempotency replay (INSERT-then-catch-23505).
//   Test 3  (PR 0.3) — nightly mode: price_per_night × nights, Gate A bypass.
//
// Harness forks (documented in PR 0.1):
//   Fork A — DB layer:      (i) full mock of ../db (transaction-aware).
//   Fork B — Auth:          (i) mock ../middleware/requireAppAuth.
//   Fork C — Notifications: (i) mock notification utils + gates to no-op.
//
// requireTenant is also stubbed directly (sets req.tenantId / req.tenantSlug).
// It stubs cleanly with no DB read, so stop-condition #4 does not apply.
//
// PR 0.2 harness extensions (additive — Test 1 unchanged):
//   - installDbMocks() now holds two closure-state counters
//     (insertBookingsCalls, insertLedgerCalls) so the 2nd attempt at
//     INSERT INTO bookings / membership_ledger throws 23505. Test 1
//     only fires each once and is unaffected.
//   - New client.query routes for the auto-consume FOR UPDATE select,
//     the idempotency-replay SELECT, the membership_ledger INSERT, and
//     the UPDATE customer_memberships balance recompute.
//   - getServiceAllowMembership defaults to { allowed: true } so the
//     eligibility guard short-circuits for Test 2 and Test 4.
//
// PR 0.3 harness extensions (additive — Tests 1, 2, 4 unchanged):
//   - The 'price_amount','price','price_per_night' column probe now
//     reports both price_amount AND price_per_night as present, so the
//     service SELECT includes price_per_night. SERVICE_ROW carries
//     price_per_night: null by default; timeslot tests still resolve
//     servicePriceAmount via the price_amount path.
//   - The 'booking_mode' bookings-column probe now reports all 7
//     nightly+addons columns. The `if (isNightlyBooking && hasNightlyCols)`
//     gates inside the INSERT build are unreachable for timeslot tests,
//     so the param contract for Tests 1, 2, 4 stays at 16 baseVals
//     before the money/rate/tax cols.
//   - taxEngine.computeTaxForBooking is now a dynamic mock returning
//     subtotal=total=chargedAmount. Test 1's chargedAmount is 25 so the
//     `tax.total_amount === SERVICE_PRICE` assertion still holds.
//   - A module-level `state.serviceRow` is reset in installDbMocks and
//     read by the `FROM services WHERE id=` route. Test 3 swaps in the
//     nightly variant before its request.
//   - installDbMocks re-applies the default getBookingPolicy so Test 3's
//     `{enforceWorkingHours: true}` override never leaks across tests.

const express = require('express');
const request = require('supertest');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID   = 1;
const TENANT_SLUG = 'test-tenant';
const SERVICE_ID  = 50;
const CUSTOMER_ID = 100;
const SERVICE_PRICE = 25;
const NEW_BOOKING_ID = 9001;

// PR 0.2 — membership / idempotency fixtures.
const MEMBERSHIP_ID = 200;
const MEMBERSHIP_INITIAL_MINUTES = 600;
const MEMBERSHIP_ROW = {
  id: MEMBERSHIP_ID,
  customer_id: CUSTOMER_ID,
  minutes_remaining: MEMBERSHIP_INITIAL_MINUTES,
  uses_remaining: 0,
};
const FIRST_LEDGER_ID = 8001;
const IDEM_KEY = 'idem-test-key-1';

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
  price_per_night: null,           // PR 0.3 — nightly column always projected
  requires_confirmation: false,
};

// PR 0.3 — nightly fixtures.
const SERVICE_NIGHTLY_PRICE = 100;
const NIGHTS_COUNT = 3;
const EXPECTED_NIGHTLY_PRICE = SERVICE_NIGHTLY_PRICE * NIGHTS_COUNT;  // 300
const SERVICE_ROW_NIGHTLY = {
  id: SERVICE_ID,
  tenant_id: TENANT_ID,
  duration_minutes: 60,             // unused for nightly pricing, but the column is in the SELECT
  max_parallel_bookings: 1,
  price_amount: null,
  price_per_night: SERVICE_NIGHTLY_PRICE,
  requires_confirmation: false,
};

// Module-level mutable state. Reset in installDbMocks; tests can override
// before sending the request. (Closure-bound by the mock implementations.)
const state = { serviceRow: SERVICE_ROW };

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
// PR 0.3 — dynamic tax mock so Test 3 (charge=300) and Test 1 (charge=25)
// both see consistent subtotal/total values. Tests 2 and 4 hit charge=0 →
// create.js skips the tax block entirely; this mock is never invoked there.
jest.mock('../utils/taxEngine', () => ({
  computeTaxForBooking: jest.fn().mockImplementation(async ({ chargedAmount }) => ({
    subtotal: chargedAmount,
    vat_amount: 0,
    service_charge_amount: 0,
    total: chargedAmount,
    snapshot: null,
  })),
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
const bookingPolicy = require('../utils/bookingPolicy');
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
  // PR 0.3 — reset module-level state for service row and the policy default
  // so per-test overrides don't leak.
  state.serviceRow = SERVICE_ROW;
  bookingPolicy.getBookingPolicy.mockResolvedValue({
    enforceWorkingHours: false,
    requireCharge: false,
  });

  // Closure-state counters — reset on every beforeEach via re-invocation.
  // 1st INSERT succeeds, 2nd+ throws 23505 (Postgres unique-violation shape).
  // Tests with one request hit the 1st-call branch only; Test 4's second
  // request lands on the 23505 branch and drives the replay path.
  let insertBookingsCalls = 0;
  let insertLedgerCalls = 0;

  // Pool reads (db.query) — routed by SQL substring (whitespace-normalized,
  // since create.js builds multi-line template-literal SQL).
  db.query.mockImplementation(async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.includes('SELECT branding FROM tenants')) return { rows: [{ branding: {} }] };
    if (s.includes('FROM customers WHERE tenant_id')) return { rows: [CUSTOMER_ROW] };
    if (s.includes("column_name='requires_confirmation'")) return { rowCount: 1, rows: [{}] };
    // PR 0.3: advertise both price_amount AND price_per_night so the services
    // SELECT projects price_per_night. Timeslot tests still read the price
    // from price_amount; nightly tests (Test 3) read price_per_night.
    if (s.includes("'price_amount','price','price_per_night'")) {
      return { rows: [
        { column_name: 'price_amount' },
        { column_name: 'price_per_night' },
      ] };
    }
    if (s.includes("column_name='currency_code'")) return { rowCount: 1, rows: [{}] };
    if (s.includes('SELECT currency_code FROM tenants')) return { rows: [{ currency_code: 'JOD' }] };
    // PR 0.3: read the per-test active service row from module state.
    if (s.includes('FROM services WHERE id=')) return { rows: [state.serviceRow] };
    if (s.includes("column_name='payment_status'")) return { rows: [{}] };
    if (s.includes("'subtotal_amount'")) return { rows: [{}, {}, {}, {}, {}] };
    // PR 0.3: advertise all 7 nightly+addons columns on bookings. The
    // `if (isNightlyBooking && hasNightlyCols)` gates inside the INSERT
    // build only fire when isNightlyBooking is true, so Tests 1, 2, 4
    // (timeslot) see no INSERT param change.
    if (s.includes("'booking_mode'")) {
      return { rows: [
        { column_name: 'booking_mode' },
        { column_name: 'checkin_date' },
        { column_name: 'checkout_date' },
        { column_name: 'nights_count' },
        { column_name: 'addons_json' },
        { column_name: 'guests_count' },
        { column_name: 'addons_total' },
      ] };
    }
    if (s.includes('FROM customer_memberships')) return { rows: [] };
    if (s.includes('FROM customer_prepaid_entitlements')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  });

  // Transaction-owning queries (client.query).
  db.__client.query.mockImplementation(async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return {};

    // INSERT INTO bookings — 1st succeeds, 2nd+ throws 23505 (idempotency replay).
    if (s.includes('INSERT INTO bookings')) {
      insertBookingsCalls++;
      if (insertBookingsCalls === 1) return { rows: [{ id: NEW_BOOKING_ID }] };
      const err = new Error(
        'duplicate key value violates unique constraint "bookings_tenant_id_idempotency_key_key"',
      );
      err.code = '23505';
      throw err;
    }

    // Replay-path lookup: the catch block selects the existing booking by idem key.
    if (s.includes('SELECT id FROM bookings') && s.includes('idempotency_key')) {
      return { rows: [{ id: NEW_BOOKING_ID }] };
    }

    // Auto-consume membership selection (FOR UPDATE) — create.js L450-469.
    if (s.includes('FROM customer_memberships') && s.includes('FOR UPDATE')) {
      return { rows: [{ ...MEMBERSHIP_ROW }] };
    }

    // Membership ledger debit — 1st succeeds, 2nd+ throws 23505 (swallowed by L1162-1165).
    if (s.includes('INSERT INTO membership_ledger')) {
      insertLedgerCalls++;
      if (insertLedgerCalls === 1) return { rows: [{ id: FIRST_LEDGER_ID }] };
      const err = new Error('duplicate key in membership_ledger');
      err.code = '23505';
      throw err;
    }

    // Balance recompute + expiry-check UPDATEs both match this branch.
    // Balance UPDATE contains GREATEST(...) and reads its return; expiry does not.
    if (s.includes('UPDATE customer_memberships')) {
      return {
        rowCount: 1,
        rows: [{
          id: MEMBERSHIP_ID,
          minutes_remaining: MEMBERSHIP_INITIAL_MINUTES - 60,
          uses_remaining: 0,
        }],
      };
    }

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
  // PR 0.2 — membership-eligible by default. Test 1 never reaches this guard.
  helpers.getServiceAllowMembership.mockResolvedValue({ allowed: true });

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

// ─── Test 2 — membership auto-consume create ──────────────────────────────────

test('membership auto-consume: paid timeslot → 201, payment_method=membership, charge_amount=0, ledger debit', async () => {
  const app = buildApp();
  const startTime = new Date(Date.now() + 86400000).toISOString();

  const res = await request(app)
    .post('/api/bookings')
    .send({
      tenantSlug: TENANT_SLUG,
      serviceId: SERVICE_ID,
      startTime,
      durationMinutes: 60,
      autoConsumeMembership: true,
    });

  await flushImmediates();

  // ── HTTP contract ──
  expect(res.status).toBe(201);
  expect(res.body.replay).toBe(false);

  const clientCalls = db.__client.query.mock.calls.map((c) => String(c[0]));

  // ── INSERT INTO bookings — once, with membership shape ──
  const insertCall = db.__client.query.mock.calls.find((c) =>
    String(c[0]).includes('INSERT INTO bookings'),
  );
  expect(insertCall).toBeDefined();
  expect(clientCalls.filter((s) => s.includes('INSERT INTO bookings'))).toHaveLength(1);

  // Same column order as Test 1 (see comment above).
  const params = insertCall[1];
  expect(params[1]).toBe(SERVICE_ID);
  expect(params[6]).toBe(CUSTOMER_ID);
  expect(params[10]).toBe('confirmed');
  expect(params[12]).toBe(MEMBERSHIP_ID);   // customer_membership_id resolved by auto-consume
  expect(params[14]).toBe('membership');    // payment_method (derived server-side)
  expect(params[15]).toBe('completed');     // payment_status
  expect(params[16]).toBe(SERVICE_PRICE);   // price_amount — still the list price
  expect(params[17]).toBe(0);               // charge_amount — covered by membership

  // ── Membership ledger — INSERT once, with the expected delta ──
  // create.js L1144-1160 param order:
  //   [0] tenant_id [1] customer_membership_id [2] booking_id
  //   [3] minutes_delta [4] uses_delta [5] note
  const ledgerInsert = db.__client.query.mock.calls.find((c) =>
    String(c[0]).includes('INSERT INTO membership_ledger'),
  );
  expect(ledgerInsert).toBeDefined();
  expect(clientCalls.filter((s) => s.includes('INSERT INTO membership_ledger'))).toHaveLength(1);
  expect(ledgerInsert[1][0]).toBe(TENANT_ID);
  expect(ledgerInsert[1][1]).toBe(MEMBERSHIP_ID);
  expect(ledgerInsert[1][2]).toBe(NEW_BOOKING_ID);
  expect(ledgerInsert[1][3]).toBe(-60);     // minutes_delta = -duration
  expect(ledgerInsert[1][4]).toBeNull();    // uses_delta = 0 → passed as null via `usesDelta || null`

  // ── Balance recompute UPDATE — once. (Expiry UPDATE may also match
  //    "UPDATE customer_memberships" — disambiguate on GREATEST.) ──
  const balanceUpdates = clientCalls.filter(
    (s) => s.includes('UPDATE customer_memberships') && s.includes('GREATEST'),
  );
  expect(balanceUpdates).toHaveLength(1);

  // ── Transaction lifecycle ──
  expect(clientCalls).toContain('BEGIN');
  expect(clientCalls).toContain('COMMIT');
  expect(clientCalls).not.toContain('ROLLBACK');

  // ── No prepaid writes ──
  expect(clientCalls.some((s) => s.includes('prepaid_redemptions'))).toBe(false);
  expect(clientCalls.some((s) => s.includes('prepaid_transactions'))).toBe(false);
});

// ─── Test 4 — idempotency replay ──────────────────────────────────────────────
//
// Two POSTs with the same idempotency key against the membership path. The
// second INSERT INTO bookings throws 23505; the catch at L1021-1033 SELECTs
// the existing booking and returns it with replay:true (status 200). The
// membership_ledger INSERT also fires twice but the second is swallowed
// (L1162-1165), so the balance UPDATE only fires once across both requests —
// proving "no double debit." Structure: option (a) per the brief — two
// requests in one test so the cross-request mock call history is the
// assertion surface.

test('idempotency replay: same key on 2nd POST returns existing booking (200, replay:true), no double-debit', async () => {
  const app = buildApp();
  helpers.getIdempotencyKey.mockReturnValue(IDEM_KEY);

  const startTime = new Date(Date.now() + 86400000).toISOString();
  const body = {
    tenantSlug: TENANT_SLUG,
    serviceId: SERVICE_ID,
    startTime,
    durationMinutes: 60,
    autoConsumeMembership: true,
  };

  const res1 = await request(app).post('/api/bookings').send(body);
  await flushImmediates();
  const res2 = await request(app).post('/api/bookings').send(body);
  await flushImmediates();

  // ── HTTP contract ──
  expect(res1.status).toBe(201);
  expect(res1.body.replay).toBe(false);
  expect(res1.body.booking.id).toBe(NEW_BOOKING_ID);

  expect(res2.status).toBe(200);            // replay status (create.js L1646)
  expect(res2.body.replay).toBe(true);
  expect(res2.body.booking.id).toBe(NEW_BOOKING_ID);

  const clientCalls = db.__client.query.mock.calls.map((c) => String(c[0]));

  // ── INSERT INTO bookings attempted twice; the 2nd throws 23505 inside
  //    the handler and falls into the replay path (no extra booking row). ──
  expect(clientCalls.filter((s) => s.includes('INSERT INTO bookings'))).toHaveLength(2);

  // ── Replay-path lookup fires exactly once, on the 2nd request only. ──
  expect(
    clientCalls.filter((s) => s.includes('SELECT id FROM bookings') && s.includes('idempotency_key')),
  ).toHaveLength(1);

  // ── Ledger: INSERT attempted twice, balance UPDATE only on the 1st
  //    request (the 2nd ledger INSERT throws 23505 → ledgerInserted stays
  //    false → balance UPDATE is skipped). This is the "no double-debit"
  //    invariant. ──
  expect(
    clientCalls.filter((s) => s.includes('INSERT INTO membership_ledger')),
  ).toHaveLength(2);
  expect(
    clientCalls.filter((s) => s.includes('UPDATE customer_memberships') && s.includes('GREATEST')),
  ).toHaveLength(1);

  // ── Transaction lifecycle — both requests committed, never rolled back. ──
  expect(clientCalls.filter((s) => s === 'BEGIN')).toHaveLength(2);
  expect(clientCalls.filter((s) => s === 'COMMIT')).toHaveLength(2);
  expect(clientCalls.filter((s) => s === 'ROLLBACK')).toHaveLength(0);
  expect(db.__client.release).toHaveBeenCalledTimes(2);
});

// ─── Test 3 — nightly mode ────────────────────────────────────────────────────
//
// Asserts three behaviors that PR 1 (dispatchNotifications extraction) and
// later persist.js work must preserve:
//
//   1. Pricing — price_per_night × nights_count flows through to both
//      price_amount and charge_amount on the INSERT.
//   2. INSERT shape — booking_mode='nightly' lands in the column added by
//      the `if (isNightlyBooking && hasNightlyCols)` branch (create.js
//      L904-906), with checkin_date / checkout_date / nights_count.
//   3. Gate A bypass — even with the tenant's policy reporting
//      enforceWorkingHours: true, validateWithinWorkingHours is NEVER
//      called for a nightly booking. This is the L355 short-circuit
//      `!isAdminBypass && !isNightlyBooking && bookingPolicy.enforceWorkingHours`.

test('nightly mode: price_per_night × nights → 201, booking_mode=nightly, Gate A bypassed', async () => {
  // Swap in the nightly service row + enable working-hours enforcement so
  // the bypass assertion is meaningful (timeslot tests rely on the policy
  // default with enforceWorkingHours: false).
  state.serviceRow = SERVICE_ROW_NIGHTLY;
  bookingPolicy.getBookingPolicy.mockResolvedValue({
    enforceWorkingHours: true,
    requireCharge: false,
  });

  const app = buildApp();

  // Use dates a few days out so we clear the nightly past-check
  // (`pastThreshold` = today midnight LOCAL, create.js L184-186).
  const ymd = (d) => d.toISOString().slice(0, 10);
  const checkin  = ymd(new Date(Date.now() + 2 * 86400000));
  const checkout = ymd(new Date(Date.now() + (2 + NIGHTS_COUNT) * 86400000));

  // NOTE: production nightly clients must send `startTime` explicitly
  // alongside checkin_date. The L170-172 "derive startTime from checkin_date"
  // path in create.js is dead code — the L96 `if (!startTime)` guard fires
  // first and 400s before the nightly derivation runs. Phase 1 finding;
  // flagged in the PR body. This test mirrors what working clients actually do.
  const startTime = new Date(`${checkin}T00:00:00Z`).toISOString();

  const res = await request(app)
    .post('/api/bookings')
    .send({
      tenantSlug:   TENANT_SLUG,
      serviceId:    SERVICE_ID,
      startTime,
      booking_mode: 'nightly',
      checkin_date: checkin,
      checkout_date: checkout,
      nights_count: NIGHTS_COUNT,
      paymentMethod: 'cash',
    });

  await flushImmediates();

  // ── HTTP contract ──
  expect(res.status).toBe(201);
  expect(res.body.replay).toBe(false);

  const clientCalls = db.__client.query.mock.calls.map((c) => String(c[0]));

  // ── INSERT INTO bookings — once, with nightly shape ──
  const insertCall = db.__client.query.mock.calls.find((c) =>
    String(c[0]).includes('INSERT INTO bookings'),
  );
  expect(insertCall).toBeDefined();
  expect(clientCalls.filter((s) => s.includes('INSERT INTO bookings'))).toHaveLength(1);

  // Column order for the nightly + full-tax branch (create.js L901-958):
  //  [0]  tenant_id           [1]  service_id          [2]  staff_id
  //  [3]  resource_id         [4]  start_time          [5]  duration_minutes
  //  [6]  customer_id         [7]  customer_name       [8]  customer_phone
  //  [9]  customer_email      [10] status              [11] idempotency_key
  //  [12] customer_membership_id  [13] session_id      [14] payment_method
  //  [15] payment_status      [16] booking_mode        [17] checkin_date
  //  [18] checkout_date       [19] nights_count        [20] addons_json
  //  [21] guests_count        [22] addons_total        [23] price_amount
  //  [24] charge_amount       [25] currency_code       [26] applied_rate_rule_id
  //  [27] applied_rate_snapshot   [28] subtotal_amount [29] vat_amount
  //  [30] service_charge_amount   [31] total_amount    [32] tax_snapshot
  const params = insertCall[1];
  expect(params[1]).toBe(SERVICE_ID);
  expect(params[6]).toBe(CUSTOMER_ID);
  expect(params[10]).toBe('confirmed');
  expect(params[12]).toBeNull();                        // no membership
  expect(params[14]).toBe('cash');                      // payment_method
  expect(params[15]).toBe('completed');                 // payment_status
  expect(params[16]).toBe('nightly');                   // booking_mode (the nightly marker)
  expect(params[17]).toBe(checkin);                     // checkin_date string passes through
  expect(params[18]).toBe(checkout);                    // checkout_date string passes through
  expect(params[19]).toBe(NIGHTS_COUNT);                // nights_count
  expect(params[20]).toBeNull();                        // addons_json — none sent
  expect(params[21]).toBe(1);                           // guests_count default
  expect(params[22]).toBe(0);                           // addons_total default
  expect(params[23]).toBe(EXPECTED_NIGHTLY_PRICE);      // price_amount = 100 × 3 = 300
  expect(params[24]).toBe(EXPECTED_NIGHTLY_PRICE);      // charge_amount === price_amount (no discount)

  // ── Tax — dynamic mock returns subtotal=total=chargedAmount=300 ──
  expect(res.body.tax.total_amount).toBe(EXPECTED_NIGHTLY_PRICE);

  // ── Gate A nightly bypass — validateWithinWorkingHours never called
  //    even though the policy reports enforceWorkingHours: true. ──
  expect(bookingPolicy.validateWithinWorkingHours).not.toHaveBeenCalled();

  // ── Transaction lifecycle ──
  expect(clientCalls).toContain('BEGIN');
  expect(clientCalls).toContain('COMMIT');
  expect(clientCalls).not.toContain('ROLLBACK');
  expect(db.__client.release).toHaveBeenCalledTimes(1);

  // ── No ledger / prepaid writes ──
  expect(clientCalls.some((s) => s.includes('membership_ledger'))).toBe(false);
  expect(clientCalls.some((s) => s.includes('prepaid_redemptions'))).toBe(false);
  expect(clientCalls.some((s) => s.includes('prepaid_transactions'))).toBe(false);
});
