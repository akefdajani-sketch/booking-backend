'use strict';

// routes/health.js
// PR-1: Observability Foundation (initial)
// PR-3: Health enrichment — adds version, environment, service name
//
// GET /health         — full readiness check (DB + memory + meta)
// GET /health/live    — shallow liveness probe (no DB call)
// GET /health/version — machine-readable version/env info only

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');

const START_TIME = Date.now();

// Safe reads so health never crashes on missing env vars
const SERVICE_NAME = process.env.RENDER_SERVICE_NAME || process.env.SERVICE_NAME || 'booking-backend';
const APP_VERSION  = process.env.APP_VERSION || process.env.npm_package_version || '1.0.0';
const NODE_ENV     = process.env.NODE_ENV || 'development';
const API_VERSION  = '1';

/**
 * GET /health
 * Full readiness check.
 * Returns 200 when all dependencies are healthy, 503 otherwise.
 * Render / UptimeRobot / load balancers should point here.
 */
router.get('/', async (req, res) => {
  const checks = {};
  let allOk = true;

  // --- Database ---
  try {
    const t0 = Date.now();
    const r = await pool.query('SELECT 1 AS ping');
    checks.database = {
      ok: true,
      latencyMs: Date.now() - t0,
      db: r.rows[0] ? 'connected' : 'unknown',
    };
  } catch (err) {
    allOk = false;
    checks.database = { ok: false, error: err.message };
    logger.error({ err }, 'Health check: DB query failed');
  }

  // --- Memory ---
  const mem = process.memoryUsage();
  const heapUsedMb  = Math.round(mem.heapUsed  / 1024 / 1024);
  const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
  const heapPct     = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const MEMORY_WARN_PCT     = 90;
  const MEMORY_CRITICAL_PCT = 98;
  const memOk       = heapPct < MEMORY_CRITICAL_PCT;
  if (!memOk) allOk = false;

  checks.memory = {
    ok: memOk,
    heapUsedMb,
    heapTotalMb,
    heapPct:     `${heapPct}%`,
    warnAt:     `${MEMORY_WARN_PCT}%`,
    criticalAt: `${MEMORY_CRITICAL_PCT}%`,
  };

  // --- Uptime ---
  const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
  checks.uptime = {
    ok: true,
    uptimeSec,
    nodePid:     process.pid,
    nodeVersion: process.version,
  };

  const status = allOk ? 200 : 503;
  res.status(status).json({
    ok:          allOk,
    status:      allOk ? 'healthy' : 'degraded',
    timestamp:   new Date().toISOString(),
    service:     SERVICE_NAME,
    version:     APP_VERSION,
    apiVersion:  API_VERSION,
    environment: NODE_ENV,
    checks,
  });
});

/**
 * GET /health/live
 * Shallow liveness probe — just confirms the process is running.
 * No DB call. Safe to poll very frequently.
 */
router.get('/live', (req, res) => {
  res.json({
    ok:      true,
    pid:     process.pid,
    service: SERVICE_NAME,
    uptime:  Math.floor((Date.now() - START_TIME) / 1000),
  });
});

/**
 * GET /health/version
 * Machine-readable version info. Useful for deployment verification.
 */
router.get('/version', (req, res) => {
  res.json({
    service:     SERVICE_NAME,
    version:     APP_VERSION,
    apiVersion:  API_VERSION,
    environment: NODE_ENV,
    nodeVersion: process.version,
    timestamp:   new Date().toISOString(),
  });
});

module.exports = router;
