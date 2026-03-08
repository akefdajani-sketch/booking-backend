'use strict';

// middleware/correlationId.js
// PR-1: Observability Foundation
// Attaches a unique X-Request-ID to every request.
// Downstream logs and Sentry events can be correlated by this ID.

const { randomUUID } = require('crypto'); // Node built-in — no extra dep needed

/**
 * Reads X-Request-ID from inbound headers (useful if a gateway / load balancer
 * already set one) and falls back to a freshly generated UUID v4.
 * The ID is written back to:
 *   - req.requestId  (for use in other middleware / route handlers)
 *   - res header X-Request-ID  (so clients / logs can correlate)
 */
function correlationId(req, res, next) {
  const id =
    (req.headers['x-request-id'] || '').trim() || randomUUID();

  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}

module.exports = correlationId;
