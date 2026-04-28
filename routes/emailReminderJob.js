'use strict';

// routes/emailReminderJob.js
// PR H (Customer booking emails).
//
// Secured HTTP endpoint that triggers the email reminder engine.
// Mirrors routes/smsReminderJob.js + routes/whatsappReminderJob.js.
//
// POST /api/email-reminder-job
//   Header: x-email-reminder-secret: <EMAIL_REMINDER_JOB_SECRET env var>
//   Body:   {} (empty — runs both 24h and 1h windows across all tenants)
//
// Setup on Render:
//   1. Set env var:   EMAIL_REMINDER_JOB_SECRET=<some-long-random-string>
//   2. Create a Render Cron Job:
//        Command:  curl -s -X POST https://<backend-host>/api/email-reminder-job \
//                    -H "x-email-reminder-secret: $EMAIL_REMINDER_JOB_SECRET" \
//                    -H "Content-Type: application/json" -d '{}'
//        Schedule: */15 * * * *   (every 15 minutes)
//
// Response:
//   { status: 'ok', elapsedMs, processed, sent, skipped, failed, details: [...] }

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { runEmailReminderEngine } = require('../utils/emailReminderEngine');

const SECRET = process.env.EMAIL_REMINDER_JOB_SECRET || '';

router.post('/', async (req, res) => {
  const provided = req.headers['x-email-reminder-secret'] || '';

  if (!SECRET) {
    logger.warn('EmailReminderJob: EMAIL_REMINDER_JOB_SECRET not set, refusing to run');
    return res.status(503).json({ error: 'Email reminder job not configured (missing secret)' });
  }

  if (provided !== SECRET) {
    logger.warn({ ip: req.ip }, 'EmailReminderJob: unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runEmailReminderEngine();
    return res.json({ status: 'ok', ...result });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'EmailReminderJob: engine threw');
    return res.status(500).json({ error: 'Email reminder engine failed.' });
  }
});

module.exports = router;
