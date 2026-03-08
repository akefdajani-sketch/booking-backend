'use strict';

// middleware/errorHandler.js
// PR-1: Observability Foundation
// Central error handler for Express.
// Replaces the inline (err, req, res, next) block in app.js.
// Logs structured errors via pino and reports to Sentry when initialised.

const logger = require('../utils/logger');
const { captureException } = require('../utils/sentry');

/**
 * Express 4-argument error-handling middleware.
 * Must be registered LAST in app.js (after all routes).
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isClientError = status >= 400 && status < 500;

  // Log with full stack for server errors; just a warning for client errors
  if (isClientError) {
    logger.warn(
      {
        err,
        requestId: req.requestId,
        tenantSlug: req.tenant?.slug,
        method: req.method,
        url: req.originalUrl,
        status,
      },
      err.message || 'Client error'
    );
  } else {
    logger.error(
      {
        err,
        requestId: req.requestId,
        tenantSlug: req.tenant?.slug,
        method: req.method,
        url: req.originalUrl,
        status,
      },
      err.message || 'Unhandled server error'
    );

    // Only report 5xx to Sentry
    captureException(err, {
      requestId: req.requestId,
      tenantSlug: req.tenant?.slug,
      url: req.originalUrl,
    });
  }

  // Never leak internal details to the client in production
  const isProd = process.env.NODE_ENV === 'production';
  res.status(status).json({
    error: isClientError
      ? err.message || 'Bad request'
      : isProd
      ? 'Internal server error'
      : err.message || 'Internal server error',
    requestId: req.requestId, // always include so clients can report it
  });
}

module.exports = errorHandler;
