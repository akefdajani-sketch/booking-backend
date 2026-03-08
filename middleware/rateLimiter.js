'use strict';

// middleware/rateLimiter.js
// PR-2: Rate Limiting + Auth Hardening
//
// Applies express-rate-limit to public-facing routes.
// Admin routes (protected by ADMIN_API_KEY) are intentionally excluded —
// the API key is the throttle there.
//
// All limiters skip in test mode so Jest doesn't need to mock them.
//
// Usage in app.js:
//   const { availabilityLimiter, publicApiLimiter, bookingCreateLimiter } = require('./middleware/rateLimiter');
//   app.use('/api/availability', availabilityLimiter, availabilityRouter);

const rateLimit = require('express-rate-limit');

const isTest = String(process.env.NODE_ENV || '').toLowerCase() === 'test';

// Shared skip — skip entirely in test runs.
const skipInTest = () => isTest;

// Standard message shape (matches our error handler convention).
function makeMessage(msg) {
  return { error: msg };
}

// ─── Limiter definitions ─────────────────────────────────────────────────────

/**
 * General public API limiter.
 * Applied to: /api/public/*
 * Generous limit — browsing pricing/theme data.
 */
const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute window
  max: 120,                      // 120 req / minute per IP
  standardHeaders: true,         // RateLimit-* headers (RFC 6585)
  legacyHeaders: false,          // no X-RateLimit-* headers
  skip: skipInTest,
  message: makeMessage('Too many requests, please try again shortly.'),
});

/**
 * Availability limiter.
 * Applied to: /api/availability
 * Higher ceiling — the booking flow calls this on every date change.
 */
const availabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,                      // 180 req / minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: makeMessage('Too many availability requests, please try again shortly.'),
});

/**
 * Booking creation limiter.
 * Applied to: POST /api/bookings
 * Tight limit — prevents booking-spam and brute-force slot reservation.
 */
const bookingCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,                       // 20 booking attempts / minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: makeMessage('Too many booking attempts, please slow down and try again.'),
});

/**
 * Tenant lookup limiter.
 * Applied to: GET /api/tenants/by-slug/:slug and GET /api/tenants/by-slug/:slug/branding
 * These are public and called by every page load of the booking app.
 */
const tenantLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,                      // 200 req / minute per IP — covers multiple tabs/reloads
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: makeMessage('Too many tenant requests, please try again shortly.'),
});

module.exports = {
  publicApiLimiter,
  availabilityLimiter,
  bookingCreateLimiter,
  tenantLookupLimiter,
};
