// routes/customerMemberships.js
//
// Thin orchestrator — mounts customer-membership sub-files onto a shared router.
// Business logic lives in routes/customerMemberships/ sub-files:
//
//   list.js    — customer self-service GET, admin GET /, admin GET /ledger
//   actions.js — PATCH archive, PATCH status, POST subscribe, POST consume-next
//   topup.js   — GET /:id/ledger, POST /:id/top-up, POST /:id/top-up-admin
//
// Schema-compat helpers (pickCol, etc.) live in utils/customerQueryHelpers.js.
// Top-up transaction helpers live in utils/membershipTopUpHelpers.js.

const express = require("express");
const router = express.Router();

require("./customerMemberships/list")(router);
require("./customerMemberships/actions")(router);
require("./customerMemberships/topup")(router);

module.exports = router;
