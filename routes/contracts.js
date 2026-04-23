'use strict';

// routes/contracts.js
// G2a-1: Long-term contracts router.
// G2a-2: Adds PDF generation + invoice send/mark-paid sub-routes.
//
// Mount in app.js:
//   app.use('/api/contracts', require('./routes/contracts'));
//
// Thin orchestrator — mounts contract sub-files onto a shared router.
//
//   create.js    — POST   /                                   (create contract, apply template)
//   list.js      — GET    /                                   (list with filters)
//   get.js       — GET    /:id                                (single contract + invoices)
//   update.js    — PATCH  /:id                                (status transitions, draft edits)
//   pdf.js       — POST   /:id/generate-pdf                   (generate unsigned PDF)
//   invoices.js  — POST   /:id/invoices/:i/send-invoice       (create Stripe invoice)
//                  POST   /:id/invoices/:i/mark-paid          (manual receipt)

const express = require('express');
const router  = express.Router();

require('./contracts/list')(router);
require('./contracts/create')(router);
require('./contracts/get')(router);
require('./contracts/update')(router);
require('./contracts/pdf')(router);       // G2a-2
require('./contracts/invoices')(router);  // G2a-2

module.exports = router;
