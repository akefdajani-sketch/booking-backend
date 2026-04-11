'use strict';

// routes/reminderJob.js
// ---------------------------------------------------------------------------
// Secured HTTP endpoint that triggers the payment link reminder engine.
//
// POST /api/reminder-job
//   Header: x-reminder-secret: <REMINDER_JOB_SECRET env var>
//   Body:   {} (empty — runs all due reminders across all tenants)
//
// Designed to be called by:
//   - Render cron jobs  (set to run every hour)
//   - cron-job.org      (free external cron, configure to POST every hour)
//   - Any HTTP scheduler
//
// Setup on Render:
//   1. Add env var:  REMINDER_JOB_SECRET=<some-long-random-string>
//   2. Create a Render Cron Job pointing to this service:
//      Command:  curl -s -X POST https://<your-backend-url>/api/reminder-job \
//                  -H "x-reminder-secret: $REMINDER_JOB_SECRET" \
//                  -H "Content-Type: application/json" -d '{}'
//      Schedule: 0 * * * *   (every hour)
//
// The endpoint is rate-limited to prevent abuse and always returns JSON.
// ---------------------------------------------------------------------------

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { runReminderEngine } = require('../utils/reminderEngine');

const SECRET = process.env.REMINDER_JOB_SECRET || '';

// ---------------------------------------------------------------------------
// POST /api/reminder-job
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  // Auth: require the secret header
  const provided = req.headers['x-reminder-secret'] || '';

  if (!SECRET) {
    // No secret configured — refuse to run (misconfiguration protection)
    logger.warn('ReminderJob: REMINDER_JOB_SECRET not set, refusing to run');
    return res.status(503).json({ error: 'Reminder job not configured (missing secret)' });
  }

  if (provided !== SECRET) {
    logger.warn({ ip: req.ip }, 'ReminderJob: unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info({ ip: req.ip }, 'ReminderJob: triggered');

  try {
    const summary = await runReminderEngine();
    return res.json({ ok: true, summary });
  } catch (err) {
    logger.error({ err }, 'ReminderJob: engine failed');
    return res.status(500).json({ ok: false, error: 'Reminder engine error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/reminder-job/status  — lightweight health check (no auth needed)
// ---------------------------------------------------------------------------
router.get('/status', (_req, res) => {
  res.json({
    configured: !!SECRET,
    message: SECRET
      ? 'Reminder job is configured. POST /api/reminder-job with x-reminder-secret header to trigger.'
      : 'REMINDER_JOB_SECRET env var not set.',
  });
});

module.exports = router;
