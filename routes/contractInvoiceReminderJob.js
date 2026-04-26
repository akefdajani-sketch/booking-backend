'use strict';

// routes/contractInvoiceReminderJob.js
// G2a-S3d: Secured HTTP endpoint that triggers the contract invoice
// reminder engine. Mirrors routes/whatsappReminderJob.js.
//
// POST /api/contract-invoice-reminder-job
//   Header: x-contract-reminder-secret: <CONTRACT_REMINDER_JOB_SECRET env var>
//
// Render cron suggested: */15 * * * * (every 15 minutes). The engine is
// cheap when nothing matches thanks to the partial index on
// contract_invoices (reminder_sent_at IS NULL AND status IN ('pending','sent')).

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { runContractInvoiceReminderEngine } = require('../utils/contractInvoiceReminderEngine');

const SECRET = process.env.CONTRACT_REMINDER_JOB_SECRET || '';

router.post('/', async (req, res) => {
  const provided = req.headers['x-contract-reminder-secret'] || '';

  if (!SECRET) {
    logger.warn('ContractInvoiceReminderJob: CONTRACT_REMINDER_JOB_SECRET not set, refusing to run');
    return res.status(503).json({
      error: 'Contract invoice reminder job not configured (missing secret)',
    });
  }

  if (provided !== SECRET) {
    logger.warn({ ip: req.ip }, 'ContractInvoiceReminderJob: unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runContractInvoiceReminderEngine();
    return res.json({ status: 'ok', ...result });
  } catch (err) {
    logger.error({ err: err.message }, 'ContractInvoiceReminderJob: engine threw');
    return res.status(500).json({ error: 'Reminder engine failed', message: err.message });
  }
});

module.exports = router;
