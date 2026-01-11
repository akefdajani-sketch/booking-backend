const express = require('express');
const request = require('supertest');

jest.mock('../db', () => ({ query: jest.fn(), pool: { query: jest.fn() } }));
const router = require('../routes/availability');

test('missing params -> 400', async () => {
  const app = express();
  app.use('/api/availability', router);
  const r = await request(app).get('/api/availability');
  expect(r.status).toBe(400);
});
