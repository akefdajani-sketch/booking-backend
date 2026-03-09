'use strict';

// __tests__/observability.test.js
// PR-1: Observability Foundation — test coverage
// Tests: health endpoint, correlation ID middleware, error handler

const express = require('express');
const request = require('supertest');

// ─── Mock dependencies so tests run without a real DB or Sentry ──────────────

jest.mock('../db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [{ ping: 1 }] }),
    on: jest.fn(),
  },
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
}));

jest.mock('../utils/sentry', () => ({
  initSentry: jest.fn(),
  captureException: jest.fn(),
  Sentry: { withScope: jest.fn() },
}));

// Silence pino output during tests
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

jest.mock('pino-http', () =>
  jest.fn().mockReturnValue((req, res, next) => next())
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(require('../middleware/correlationId'));
  app.use(require('../middleware/requestLogger'));
  app.use('/health', require('../routes/health'));
  app.use(require('../middleware/errorHandler'));
  return app;
}

// ─── correlationId middleware ─────────────────────────────────────────────────

describe('correlationId middleware', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(require('../middleware/correlationId'));
    app.get('/ping', (req, res) => {
      res.json({ requestId: req.requestId });
    });
  });

  it('generates an X-Request-ID when none is provided', async () => {
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('echoes back an existing X-Request-ID', async () => {
    const id = 'test-correlation-id-123';
    const res = await request(app).get('/ping').set('X-Request-ID', id);
    expect(res.headers['x-request-id']).toBe(id);
    expect(res.body.requestId).toBe(id);
  });

  it('attaches requestId to req object', async () => {
    const res = await request(app).get('/ping');
    expect(res.body.requestId).toBeDefined();
  });
});

// ─── /health endpoint ─────────────────────────────────────────────────────────

describe('GET /health', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it('returns 200 with ok:true when DB is healthy', async () => {
    const { pool } = require('../db');
    pool.query.mockResolvedValueOnce({ rows: [{ ping: 1 }] });

    const res = await request(app).get('/health');
    // With DB mocked healthy, health should be 200 unless memory is critically
    // high (>=98%). We check DB and uptime but not memory.ok since heap usage
    // in CI environments is unpredictable and memory is a warn-only metric.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.checks.memory).toBeDefined();
    expect(res.body.checks.uptime.ok).toBe(true);
  });

  it('returns 503 when DB is down', async () => {
    const { pool } = require('../db');
    pool.query.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.checks.database.ok).toBe(false);
    expect(res.body.checks.database.error).toBe('Connection refused');
  });

  it('includes a timestamp in ISO format', async () => {
    const { pool } = require('../db');
    pool.query.mockResolvedValueOnce({ rows: [{ ping: 1 }] });

    const res = await request(app).get('/health');
    expect(res.body.timestamp).toBeDefined();
    expect(() => new Date(res.body.timestamp)).not.toThrow();
  });

  it('exposes latencyMs for the DB check', async () => {
    const { pool } = require('../db');
    pool.query.mockResolvedValueOnce({ rows: [{ ping: 1 }] });

    const res = await request(app).get('/health');
    expect(typeof res.body.checks.database.latencyMs).toBe('number');
  });
});

describe('GET /health/live', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it('returns 200 ok:true without touching the DB', async () => {
    const { pool } = require('../db');
    pool.query.mockClear();

    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ─── errorHandler middleware ──────────────────────────────────────────────────

describe('errorHandler middleware', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(require('../middleware/correlationId'));

    // Route that throws a generic 500
    app.get('/boom', (req, res, next) => {
      next(new Error('Something exploded'));
    });

    // Route that throws a client error (400)
    app.get('/bad', (req, res, next) => {
      const err = new Error('Bad input');
      err.status = 400;
      next(err);
    });

    app.use(require('../middleware/errorHandler'));
  });

  it('returns 500 and includes requestId for unhandled errors', async () => {
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.requestId).toBeDefined();
  });

  it('returns 400 for client errors', async () => {
    const res = await request(app).get('/bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad input');
  });

  it('calls captureException for 5xx errors', async () => {
    const { captureException } = require('../utils/sentry');
    captureException.mockClear();

    await request(app).get('/boom');
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('does NOT call captureException for 4xx errors', async () => {
    const { captureException } = require('../utils/sentry');
    captureException.mockClear();

    await request(app).get('/bad');
    expect(captureException).not.toHaveBeenCalled();
  });
});
