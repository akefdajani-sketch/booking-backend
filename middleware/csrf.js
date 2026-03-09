'use strict';
// middleware/csrf.js  — PR-16: CSRF Protection
//
// Stateless double-submit cookie pattern.
// • GET /api/csrf-token   → issues token (cookie + JSON body)
// • csrfProtection        → validates token on mutating requests
//
// Endpoints already protected by requireGoogleAuth (Authorization: Bearer)
// do NOT need csrfProtection — cross-origin requests can't set custom headers
// without a CORS preflight, which our CORS config already blocks.

const crypto = require('crypto');

const COOKIE_NAME  = 'x-csrf';
const HEADER_NAME  = 'x-csrf-token';
const TOKEN_BYTES  = 32;
const MAX_AGE_SECS = 60 * 60 * 4; // 4 hours

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// ── GET /api/csrf-token ───────────────────────────────────────────────────────
function getCsrfToken(req, res) {
  const existing = req.cookies?.[COOKIE_NAME];
  const valid    = existing && existing.length === TOKEN_BYTES * 2;
  const token    = valid ? existing : generateToken();

  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: false,          // JS must read it to put in header
    secure:   isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge:   MAX_AGE_SECS * 1000,
    path:     '/',
  });
  return res.json({ csrfToken: token });
}

// ── Validation middleware ─────────────────────────────────────────────────────
function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
    return next();
  }

  const cookieToken = req.cookies?.[COOKIE_NAME] || '';
  const headerToken = (req.headers[HEADER_NAME] || '').trim();

  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: 'CSRF token missing.' });
  }

  try {
    const a = Buffer.from(cookieToken, 'hex');
    const b = Buffer.from(headerToken, 'hex');
    if (a.length !== TOKEN_BYTES || b.length !== TOKEN_BYTES) {
      return res.status(403).json({ error: 'CSRF token malformed.' });
    }
    if (!crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'CSRF token mismatch.' });
    }
  } catch {
    return res.status(403).json({ error: 'CSRF token invalid.' });
  }

  return next();
}

module.exports = { getCsrfToken, csrfProtection };
