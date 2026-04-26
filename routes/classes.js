'use strict';

// routes/classes.js
// G1: Group / class booking router.
//
// Mount in app.js:
//   app.use('/api/classes', require('./routes/classes'));
//
// Auth middleware is applied at the router level — every endpoint requires
// authenticated tenant staff. This avoids repeating the chain on every route.
//
// Sub-files (mounted in order; later files do not depend on earlier ones):
//   sessions.js           — read endpoints (list, get with roster)
//   sessions-admin.js     — write endpoints (create, update, cancel session)
//   seats.js              — seat operations + waitlist
//   instructors.js        — CRUD for the instructors table

const express = require('express');
const router = express.Router();

const requireAppAuth           = require('../middleware/requireAppAuth');
const { requireTenant }        = require('../middleware/requireTenant');
const requireAdminOrTenantRole = require('../middleware/requireAdminOrTenantRole');

// Apply auth to every endpoint mounted on this router.
router.use(requireAppAuth);
router.use(requireTenant);
router.use(requireAdminOrTenantRole('staff'));

require('./classes/sessions')(router);
require('./classes/sessions-admin')(router);
require('./classes/seats')(router);
require('./classes/instructors')(router);

module.exports = router;
