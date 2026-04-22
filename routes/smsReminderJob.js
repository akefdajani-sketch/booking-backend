'use strict';

// routes/smsReminderJob.js
// ---------------------------------------------------------------------------
// Secured HTTP endpoint that triggers the SMS reminder engine (H3.5.2).
//
// POST /api/sms-reminder-job
//   Header: x-sms-reminder-secret: <SMS_REMINDER_JOB_SECRET env var>
//   Body:   {} (empty — runs all due reminders across all tenants)
//
// Same pattern as routes/reminderJob.js (payment reminders) and
// routes/demoResetJob.js (demo reset).
//
// Designed to be called by:
//   - Render cron jobs  (recommended: every 15 minutes)
//   - cron-job.org      (free external cron)
//   - Any HTTP scheduler
//
// Setup on Render:
//   1. Add env var:  SMS_REMINDER_JOB_SECRET=<some-long-random-string>
//   2. Create a Render Cron Job pointing to this service:
//      Command:  curl -s -X POST https://<backend-host>/api/sms-reminder-job \
//                  -H "x-sms-reminder-secret: $SMS_REMINDER_JOB_SECRET" \
//                  -H "Content-Type: application/json" -d '{}'
//      Schedule: */15 * * * *   (every 15 minutes)
//
// Response:
//   { status: 'ok', elapsedMs, processed, sent, skipped, failed, details: [...] }
// ---------------------------------------------------------------------------

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { runSmsReminderEngine } = require('../utils/smsReminderEngine');

const SECRET = process.env.SMS_REMINDER_JOB_SECRET || '';

router.post('/', async (req, res) => {
  const provided = req.headers['x-sms-reminder-secret'] || '';

  if (!SECRET) {
    logger.warn('SmsReminderJob: SMS_REMINDER_JOB_SECRET not set, refusing to run');
    return res.status(503).json({ error: 'SMS reminder job not configured (missing secret)' });
  }

  if (provided !== SECRET) {
    logger.warn({ ip: req.ip }, 'SmsReminderJob: unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runSmsReminderEngine();
    return res.json({ status: 'ok', ...result });
  } catch (err) {
    logger.error({ err: err.message }, 'SmsReminderJob: engine threw');
    return res.status(500).json({ error: 'Reminder engine failed', message: err.message });
  }
});

module.exports = router;
