'use strict';

// routes/contracts.js
// G2a-1: Long-term contracts router.
//
// Mount in app.js:
//   app.use('/api/contracts', require('./routes/contracts'));
//
// Thin orchestrator — mounts contract sub-files onto a shared router.
//
//   create.js  — POST   / (create contract, optionally apply template)
//   list.js    — GET    / (list with filters)
//   get.js     — GET    /:id (single contract + invoices)
//   update.js  — PATCH  /:id (status transitions, field edits on drafts)

const express = require('express');
const router  = express.Router();

require('./contracts/list')(router);
require('./contracts/create')(router);
require('./contracts/get')(router);
require('./contracts/update')(router);

module.exports = router;
