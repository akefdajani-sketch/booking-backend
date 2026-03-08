'use strict';

// utils/logger.js
// PR-1: Observability Foundation
// Replaces all console.log / console.error throughout the app.
// In production: outputs newline-delimited JSON (for log aggregators).
// In development: pretty-prints with pino-pretty.

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: 'booking-backend',
      env: process.env.NODE_ENV || 'development',
    },
    // Redact sensitive fields wherever they appear in log objects
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.secret',
        '*.apiKey',
        '*.api_key',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,service,env',
          messageFormat: '[{service}] {msg}',
        },
      })
    : undefined
);

module.exports = logger;
