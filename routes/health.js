'use strict';

// routes/health.js
// PR-1: Observability Foundation
// Replaces the previous /health/db-only route.
// GET /health         — full readiness check (DB + memory)
// GET /health/live    — shallow liveness probe (no DB call, for k8s / Render)

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');

const START_TIME = Date.now();

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
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
  const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const memOk = heapPct < 90; // warn if heap is >90% full
  if (!memOk) allOk = false;

  checks.memory = {
    ok: memOk,
    heapUsedMb,
    heapTotalMb,
    heapPct: `${heapPct}%`,
  };

  // --- Uptime ---
  checks.uptime = {
    ok: true,
    uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
    nodePid: process.pid,
    nodeVersion: process.version,
  };

  const status = allOk ? 200 : 503;
  res.status(status).json({
    ok: allOk,
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * GET /health/live
 * Shallow liveness probe — just confirms the process is running.
 * No DB call. Safe to poll very frequently.
 */
router.get('/live', (req, res) => {
  res.json({ ok: true, pid: process.pid });
});

module.exports = router;
