'use strict';

// __tests__/tenantBookingUrl.test.js
// Locks the contract for the shared booking-URL helper. The helper is
// the single source of truth for "what URL do we send the customer to
// view their booking?" — every notification channel (email/WA/SMS)
// routes through it, so a regression here would re-introduce the
// 2026-05-24 wrong-host bug across all channels at once.

// Mock the db module so the helper can be exercised without a real DB.
// The helper calls db.query exactly once per invocation; we control
// the resolved value per test.
jest.mock('../db', () => ({
  query: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../db');
const { resolveTenantBookingUrl } = require('../utils/tenantBookingUrl');

describe('utils/tenantBookingUrl — resolveTenantBookingUrl', () => {
  beforeEach(() => {
    db.query.mockReset();
    delete process.env.BOOKING_FRONTEND_URL;
  });

  test('uses the tenant primary custom domain when present', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ domain: 'birdiegolf-jo.com' }] });
    const url = await resolveTenantBookingUrl(3, 'birdie-golf', 'ABC123');
    expect(url).toBe('https://birdiegolf-jo.com?ref=ABC123');
  });

  test('falls back to the platform booking URL when no custom domain exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const url = await resolveTenantBookingUrl(3, 'birdie-golf', 'ABC123');
    expect(url).toBe('https://flexrz.com/book/birdie-golf?ref=ABC123');
  });

  test('honors BOOKING_FRONTEND_URL override in the platform fallback', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    process.env.BOOKING_FRONTEND_URL = 'https://staging.flexrz.com';
    const url = await resolveTenantBookingUrl(3, 'birdie-golf', 'ABC123');
    expect(url).toBe('https://staging.flexrz.com/book/birdie-golf?ref=ABC123');
  });

  test('omits the ?ref= query string when bookingCode is not provided', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ domain: 'birdiegolf-jo.com' }] });
    const url = await resolveTenantBookingUrl(3, 'birdie-golf');
    expect(url).toBe('https://birdiegolf-jo.com');
  });

  test('encodes the booking code for deep-link safety', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const url = await resolveTenantBookingUrl(3, 'birdie-golf', 'A B&C');
    expect(url).toBe('https://flexrz.com/book/birdie-golf?ref=A%20B%26C');
  });

  test('treats a DB error as non-fatal and falls through to the platform URL', async () => {
    db.query.mockRejectedValueOnce(new Error('connection refused'));
    const url = await resolveTenantBookingUrl(3, 'birdie-golf', 'ABC');
    expect(url).toBe('https://flexrz.com/book/birdie-golf?ref=ABC');
  });

  test('does NOT double-prefix when domain already starts with http(s)://', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ domain: 'https://birdiegolf-jo.com' }] });
    const url = await resolveTenantBookingUrl(3, 'birdie-golf', 'ABC');
    expect(url).toBe('https://birdiegolf-jo.com?ref=ABC');
  });

  test('strips trailing slash on the custom domain', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ domain: 'birdiegolf-jo.com/' }] });
    const url = await resolveTenantBookingUrl(3, 'birdie-golf', 'ABC');
    expect(url).toBe('https://birdiegolf-jo.com?ref=ABC');
  });

  test('returns null only when slug is missing AND no custom domain exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const url = await resolveTenantBookingUrl(3, null, 'ABC');
    expect(url).toBeNull();
  });

  test('returns custom domain URL even when slug is null (custom domain root works without slug)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ domain: 'birdiegolf-jo.com' }] });
    const url = await resolveTenantBookingUrl(3, null, 'ABC');
    expect(url).toBe('https://birdiegolf-jo.com?ref=ABC');
  });
});
