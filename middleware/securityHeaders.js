'use strict';

// middleware/securityHeaders.js
// PR-8: GDPR DSR + SOC-2 Audit Prep
//
// Adds HTTP security headers to every response.
// These are part of SOC-2 "Logical and Physical Access Controls" and
// "System Operations" criteria (CC6, CC7).
//
// No external dependencies — zero weight on the dependency graph.

/**
 * Sets security-relevant HTTP response headers.
 * Mount early in app.js (after correlationId, before routes).
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function securityHeaders(req, res, next) {
  // Prevent browsers from MIME-sniffing the content type
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Block clickjacking — API responses are never framed
  res.setHeader('X-Frame-Options', 'DENY');

  // XSS protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer policy — don't leak URL params in Referer header to third-parties
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy — API server has no need for browser features
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );

  // HSTS — only set in production (breaks localhost HTTPS-less dev)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }

  // Remove Express fingerprint header
  res.removeHeader('X-Powered-By');

  next();
}

module.exports = securityHeaders;
