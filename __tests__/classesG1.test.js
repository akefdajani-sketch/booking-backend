'use strict';

// __tests__/classesG1.test.js
// G1: Tests for utils/classSeats.js + routes/classes/*.

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockConnect = jest.fn();

jest.mock('../db', () => ({
  pool: { query: (...a) => mockQuery(...a), connect: (...a) => mockConnect(...a), on: jest.fn() },
  query: (...a) => mockQuery(...a),
  connect: (...a) => mockConnect(...a),
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), error: jest.fn() })),
}));

jest.mock('../middleware/requireAppAuth', () => (req, res, next) => {
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

// Helper to make a fake transactional client
function makeFakeClient() {
  const calls = [];
  const client = {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      // Default to a single row generic ack; tests override per call sequence.
      return { rows: [{}], rowCount: 1 };
    }),
    release: jest.fn(),
  };
  return client;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('G1: classSeats', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockConnect.mockReset();
  });

  describe('bookSeat', () => {
    it('books happily when capacity is available', async () => {
      const client = makeFakeClient();
      // Sequence:
      //   1. BEGIN
      //   2. SELECT FOR UPDATE on session  → session with cap=10, status=scheduled
      //   3. SELECT COUNT(*) on seats      → booked=3
      //   4. INSERT seat                   → returns inserted row
      //   5. COMMIT
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // BEGIN
        .mockResolvedValueOnce({                            // SELECT session FOR UPDATE
          rows: [{
            id: 100, tenant_id: 33, service_id: 5, capacity: 10, status: 'scheduled',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ n: 3 }] })       // count seats
        .mockResolvedValueOnce({                            // INSERT seat
          rows: [{
            id: 9001, session_id: 100, customer_id: 7, status: 'confirmed',
          }],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
      mockConnect.mockResolvedValueOnce(client);

      const { bookSeat } = require('../utils/classSeats');
      const result = await bookSeat({
        tenantId: 33, sessionId: 100, customerId: 7,
      });
      expect(result.ok).toBe(true);
      expect(result.seat.id).toBe(9001);
      expect(client.release).toHaveBeenCalled();
    });

    it('returns session_full + waitlist_eligible flag when capacity hit', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // BEGIN
        .mockResolvedValueOnce({                            // SELECT session
          rows: [{
            id: 100, tenant_id: 33, service_id: 5, capacity: 10, status: 'scheduled',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ n: 10 }] })       // count seats = full
        .mockResolvedValueOnce({                            // SELECT service.waitlist_enabled
          rows: [{ waitlist_enabled: true }],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { bookSeat } = require('../utils/classSeats');
      const result = await bookSeat({ tenantId: 33, sessionId: 100, customerId: 7 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('session_full');
      expect(result.waitlist_eligible).toBe(true);
    });

    it('returns duplicate_seat on unique violation (23505)', async () => {
      const client = makeFakeClient();
      const dupErr = new Error('duplicate'); dupErr.code = '23505';
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({                           // SELECT session
          rows: [{ id: 100, capacity: 10, status: 'scheduled', service_id: 5 }],
        })
        .mockResolvedValueOnce({ rows: [{ n: 5 }] })       // count seats
        .mockRejectedValueOnce(dupErr)                     // INSERT seat throws
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { bookSeat } = require('../utils/classSeats');
      const result = await bookSeat({ tenantId: 33, sessionId: 100, customerId: 7 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('duplicate_seat');
    });

    it('returns session_cancelled when session.status is cancelled', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({                           // SELECT session
          rows: [{ id: 100, capacity: 10, status: 'cancelled', service_id: 5 }],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { bookSeat } = require('../utils/classSeats');
      const result = await bookSeat({ tenantId: 33, sessionId: 100, customerId: 7 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('session_cancelled');
    });

    it('returns session_not_found when session lookup is empty', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({ rows: [] })               // SELECT session → none
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { bookSeat } = require('../utils/classSeats');
      const result = await bookSeat({ tenantId: 33, sessionId: 999, customerId: 7 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('session_not_found');
    });
  });

  describe('cancelSeat', () => {
    it('cancels and returns no promotion when waitlist is empty', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({                           // SELECT seat
          rows: [{ id: 50, session_id: 100, status: 'confirmed' }],
        })
        .mockResolvedValueOnce({                           // UPDATE seat → cancelled
          rows: [{ id: 50, status: 'cancelled' }],
        })
        .mockResolvedValueOnce({ rows: [] })               // SELECT waitlist FOR UPDATE → none
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
      mockConnect.mockResolvedValueOnce(client);

      const { cancelSeat } = require('../utils/classSeats');
      const result = await cancelSeat({ tenantId: 33, seatId: 50 });
      expect(result.ok).toBe(true);
      expect(result.promoted).toBeNull();
    });

    it('auto-promotes waitlist #1 to a confirmed seat on cancellation', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({                           // SELECT seat (the one being cancelled)
          rows: [{ id: 50, session_id: 100, status: 'confirmed' }],
        })
        .mockResolvedValueOnce({                           // UPDATE seat → cancelled
          rows: [{ id: 50, status: 'cancelled' }],
        })
        .mockResolvedValueOnce({                           // SELECT waitlist FOR UPDATE → #1
          rows: [{ id: 700, session_id: 100, customer_id: 99, position: 1 }],
        })
        .mockResolvedValueOnce({                           // INSERT new seat for promoted customer
          rows: [{ id: 51, session_id: 100, customer_id: 99, status: 'confirmed' }],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE waitlist → promoted
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
      mockConnect.mockResolvedValueOnce(client);

      const { cancelSeat } = require('../utils/classSeats');
      const result = await cancelSeat({ tenantId: 33, seatId: 50 });
      expect(result.ok).toBe(true);
      expect(result.promoted).not.toBeNull();
      expect(result.promoted.seat.id).toBe(51);
      expect(result.promoted.waitlist_id).toBe(700);
    });

    it('returns seat_not_found for missing seat', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({ rows: [] })               // SELECT seat → none
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { cancelSeat } = require('../utils/classSeats');
      const result = await cancelSeat({ tenantId: 33, seatId: 999 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('seat_not_found');
    });

    it('returns seat_already_cancelled for already-cancelled seats', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({                           // SELECT seat
          rows: [{ id: 50, session_id: 100, status: 'cancelled' }],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { cancelSeat } = require('../utils/classSeats');
      const result = await cancelSeat({ tenantId: 33, seatId: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('seat_already_cancelled');
    });
  });

  describe('joinWaitlist', () => {
    it('returns session_has_capacity when there are still seats available', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // BEGIN
        .mockResolvedValueOnce({                            // SELECT session+waitlist_enabled
          rows: [{ id: 100, capacity: 10, status: 'scheduled', waitlist_enabled: true }],
        })
        .mockResolvedValueOnce({ rows: [{ n: 3 }] })        // count seats = 3 < 10
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { joinWaitlist } = require('../utils/classSeats');
      const result = await joinWaitlist({ tenantId: 33, sessionId: 100, customerId: 99 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('session_has_capacity');
    });

    it('returns waitlist_disabled when service has no waitlist', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // BEGIN
        .mockResolvedValueOnce({                            // SELECT session
          rows: [{ id: 100, capacity: 10, status: 'scheduled', waitlist_enabled: false }],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { joinWaitlist } = require('../utils/classSeats');
      const result = await joinWaitlist({ tenantId: 33, sessionId: 100, customerId: 99 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('waitlist_disabled');
    });

    it('joins with computed position when session is full', async () => {
      const client = makeFakeClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // BEGIN
        .mockResolvedValueOnce({                            // SELECT session
          rows: [{ id: 100, capacity: 10, status: 'scheduled', waitlist_enabled: true }],
        })
        .mockResolvedValueOnce({ rows: [{ n: 10 }] })       // count seats = full
        .mockResolvedValueOnce({ rows: [{ next_pos: 4 }] }) // next position = 4
        .mockResolvedValueOnce({                            // INSERT waitlist
          rows: [{ id: 700, session_id: 100, customer_id: 99, position: 4, status: 'waiting' }],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // COMMIT
      mockConnect.mockResolvedValueOnce(client);

      const { joinWaitlist } = require('../utils/classSeats');
      const result = await joinWaitlist({ tenantId: 33, sessionId: 100, customerId: 99 });
      expect(result.ok).toBe(true);
      expect(result.entry.position).toBe(4);
    });

    it('returns duplicate_waitlist when customer already on the list', async () => {
      const client = makeFakeClient();
      const dupErr = new Error('duplicate'); dupErr.code = '23505';
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // BEGIN
        .mockResolvedValueOnce({                            // SELECT session
          rows: [{ id: 100, capacity: 10, status: 'scheduled', waitlist_enabled: true }],
        })
        .mockResolvedValueOnce({ rows: [{ n: 10 }] })       // full
        .mockResolvedValueOnce({ rows: [{ next_pos: 1 }] }) // next pos
        .mockRejectedValueOnce(dupErr)                       // INSERT throws
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // ROLLBACK
      mockConnect.mockResolvedValueOnce(client);

      const { joinWaitlist } = require('../utils/classSeats');
      const result = await joinWaitlist({ tenantId: 33, sessionId: 100, customerId: 99 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('duplicate_waitlist');
    });
  });

  describe('checkIn', () => {
    it('flips a confirmed seat to checked_in', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 50, status: 'checked_in', checked_in_at: new Date().toISOString() }],
      });
      const { checkIn } = require('../utils/classSeats');
      const result = await checkIn({ tenantId: 33, seatId: 50, staffId: 7 });
      expect(result.ok).toBe(true);
      expect(result.seat.status).toBe('checked_in');
    });

    it('returns seat_not_eligible when seat is not in confirmed state', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const { checkIn } = require('../utils/classSeats');
      const result = await checkIn({ tenantId: 33, seatId: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('seat_not_eligible');
    });
  });
});

// ─── Routes — light smoke ────────────────────────────────────────────────────

describe('G1: /api/classes routes (smoke)', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    mockQuery.mockReset();
    mockConnect.mockReset();

    app = express();
    app.use(express.json());
    app.use('/api/classes', require('../routes/classes'));
  });

  it('GET /sessions returns 200 with empty array when no sessions', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/classes/sessions').set('x-test-tenant-id', '33');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBe(0);
  });

  it('GET /sessions/:id returns 404 when session not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/classes/sessions/999').set('x-test-tenant-id', '33');
    expect(res.status).toBe(404);
  });

  it('POST /instructors creates an instructor', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, name: 'Yara', tenant_id: 33, is_active: true }],
    });
    const res = await request(app)
      .post('/api/classes/instructors')
      .set('x-test-tenant-id', '33')
      .send({ name: 'Yara' });
    expect(res.status).toBe(201);
    expect(res.body.instructor.name).toBe('Yara');
  });

  it('POST /instructors rejects empty name', async () => {
    const res = await request(app)
      .post('/api/classes/instructors')
      .set('x-test-tenant-id', '33')
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('PATCH /sessions/:id rejects capacity below booked count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: 5 }] });
    const res = await request(app)
      .patch('/api/classes/sessions/100')
      .set('x-test-tenant-id', '33')
      .send({ capacity: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('capacity_below_booked');
  });
});
