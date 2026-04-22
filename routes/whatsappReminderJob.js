'use strict';

// routes/whatsappReminderJob.js
// ---------------------------------------------------------------------------
// Secured HTTP endpoint that triggers the WhatsApp reminder engine (H3.5.3).
// Mirror of routes/smsReminderJob.js.
//
// POST /api/whatsapp-reminder-job
//   Header: x-wa-reminder-secret: <WA_REMINDER_JOB_SECRET env var>
//
// Render cron suggested: */15 * * * *
// ---------------------------------------------------------------------------

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { runWhatsappReminderEngine } = require('../utils/whatsappReminderEngine');

const SECRET = process.env.WA_REMINDER_JOB_SECRET || '';

router.post('/', async (req, res) => {
  const provided = req.headers['x-wa-reminder-secret'] || '';

  if (!SECRET) {
    logger.warn('WhatsappReminderJob: WA_REMINDER_JOB_SECRET not set, refusing to run');
    return res.status(503).json({ error: 'WhatsApp reminder job not configured (missing secret)' });
  }

  if (provided !== SECRET) {
    logger.warn({ ip: req.ip }, 'WhatsappReminderJob: unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runWhatsappReminderEngine();
    return res.json({ status: 'ok', ...result });
  } catch (err) {
    logger.error({ err: err.message }, 'WhatsappReminderJob: engine threw');
    return res.status(500).json({ error: 'Reminder engine failed', message: err.message });
  }
});

module.exports = router;
