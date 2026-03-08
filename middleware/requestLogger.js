'use strict';

// middleware/requestLogger.js
// PR-1: Observability Foundation
// Logs every HTTP request/response using pino-http.
// Includes correlation ID, tenant slug (if present), and response time.

const pinoHttp = require('pino-http');
const logger = require('../utils/logger');

const requestLogger = pinoHttp({
  logger,

  // Include the correlation ID set by correlationId middleware
  genReqId(req) {
    return req.requestId;
  },

  // Customise what gets logged on each request
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },

  // Add tenant slug to log line when available
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },

  customErrorMessage(req, res, err) {
    return `${req.method} ${req.url} ${res.statusCode} — ${err.message}`;
  },

  // Enrich log with tenant context if set by requireTenant middleware
  customProps(req) {
    return {
      tenantSlug: req.tenant?.slug || undefined,
      requestId: req.requestId,
    };
  },

  // Don't log health checks — they are very noisy
  autoLogging: {
    ignore(req) {
      return req.url === '/health';
    },
  },

  // Don't log request/response bodies — they can contain PII
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});

module.exports = requestLogger;
