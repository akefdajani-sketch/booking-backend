// index.js (root entry point for Render)
// Render runs: node index.js
// PR-1: initialise Sentry and structured logging before anything else loads.

'use strict';

// Sentry must be initialised as early as possible — before requiring app.js
const { initSentry } = require('./utils/sentry');
initSentry();

const logger = require('./utils/logger');

logger.info('BOOT: running root index.js -> server.js');

// Catch unhandled async rejections and uncaught exceptions.
// Previously these used console.error — now they go through pino + Sentry.
process.on('unhandledRejection', (reason, promise) => {
  logger.error(
    { err: reason instanceof Error ? reason : new Error(String(reason)), promise },
    'Unhandled Promise Rejection'
  );
  const { captureException } = require('./utils/sentry');
  if (reason instanceof Error) captureException(reason);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught Exception — process will exit');
  const { captureException } = require('./utils/sentry');
  captureException(err);
  // Give Sentry 2s to flush before the process dies
  setTimeout(() => process.exit(1), 2000);
});

require('./server');
