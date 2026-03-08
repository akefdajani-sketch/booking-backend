const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../middleware/requireTenant', () => ({ requireTenant: (req, res, next) => next() }));
jest.mock('../middleware/requireGoogleAuth', () => (req, _res, next) => next());
jest.mock('../utils/bookings', () => ({ checkConflicts: jest.fn(), loadJoinedBookingById: jest.fn() }));

const { pool } = require('../db');
const router = require('../routes/bookings');

test('tenant mismatch → 400', async () => {
  pool.query.mockImplementation(async (sql) => {
    if (String(sql).includes('FROM tenants WHERE slug')) {
      return { rows: [{ id: 1 }] };
    }
    return { rows: [] };
  });

  const app = express();
  app.use(express.json());
  app.use('/api/bookings', router);

  const res = await request(app)
    .post('/api/bookings')
    .send({ tenantSlug: 't1', tenantId: 999 });

  expect(res.status).toBe(400);
});
