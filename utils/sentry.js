'use strict';

// utils/sentry.js
// PR-1: Observability Foundation
// Initialises Sentry if SENTRY_DSN is set.
// Safe no-op when DSN is absent (local dev / staging without Sentry).

const Sentry = require('@sentry/node');
const logger = require('./logger');

let initialised = false;

function initSentry() {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    logger.info('Sentry DSN not set — error reporting disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION || undefined,

    // Only trace a fraction in production to stay inside free quota
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Don't send 4xx errors — those are client mistakes, not our bugs
    beforeSend(event) {
      const statusCode = event?.contexts?.response?.status_code;
      if (statusCode && statusCode >= 400 && statusCode < 500) return null;
      return event;
    },
  });

  initialised = true;
  logger.info({ release: process.env.RENDER_GIT_COMMIT }, 'Sentry initialised');
}

/**
 * Capture an exception. Safe to call whether or not Sentry is initialised.
 * @param {Error} err
 * @param {object} [extra]  additional context key/value pairs
 */
function captureException(err, extra = {}) {
  if (!initialised) return;
  Sentry.withScope((scope) => {
    Object.entries(extra).forEach(([k, v]) => scope.setExtra(k, v));
    Sentry.captureException(err);
  });
}

module.exports = { initSentry, captureException, Sentry };
