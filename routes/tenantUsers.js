// routes/tenantUsers.js
//
// Thin orchestrator — mounts tenant users sub-files onto a shared router.
//
//   me.js      — GET /:slug/me, GET /:slug/publish-status, GET /:slug/users
//   invites.js — POST invite, POST manual-add, GET invites, POST resend, DELETE invite
//   users.js   — PATCH /:slug/users/:userId, DELETE /:slug/users/:userId
//
// Shared helpers → utils/tenantUsersHelpers.js

const express = require("express");
const router  = express.Router();

require("./tenantUsers/me")(router);
require("./tenantUsers/invites")(router);
require("./tenantUsers/users")(router);

module.exports = router;
