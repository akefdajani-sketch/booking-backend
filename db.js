// db.js
'use strict';

const { Pool } = require('pg');
const logger = require('./utils/logger');

const isProd = process.env.NODE_ENV === 'production';
const useSSL =
  process.env.DATABASE_SSL != null
    ? String(process.env.DATABASE_SSL).toLowerCase() === 'true'
    : isProd;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,

  max: Number(process.env.PGPOOL_MAX || 5),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE || 30000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT || 10000),
});

// PR-1: structured log instead of console.error
pool.on('error', (err) => {
  logger.error({ err }, 'PG pool unexpected error');
  const { captureException } = require('./utils/sentry');
  captureException(err, { source: 'pg_pool' });
});

module.exports = {
  pool,
  query: (...args) => pool.query(...args),
  connect: (...args) => pool.connect(...args),
};
