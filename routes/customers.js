// routes/customers.js
//
// Thin orchestrator — mounts customer route sub-files onto a shared router.
// Business logic lives in routes/customers/ sub-files:
//
//   admin.js         — GET /search, GET /, POST /, DELETE /:id, PATCH /:id/restore
//   meProfile.js     — POST /me, GET /me, GET /me/session, GET /me/versions
//   mePrepaid.js     — GET /me/prepaid-entitlements, GET /me/prepaid-summary
//   meBookings.js    — GET /me/bookings, DELETE /me/bookings/:id
//   meMemberships.js — GET /me/memberships, GET /me/memberships/:id/ledger, POST /me/memberships/subscribe
//   mePackages.js    — GET /me/packages, GET /me/packages/:id/ledger, POST /me/packages/:id/purchase
//
// Schema-compat helpers (pickCol, etc.) live in utils/customerQueryHelpers.js.

const express = require("express");
const router = express.Router();

require("./customers/meProfile")(router);
require("./customers/mePrepaid")(router);
require("./customers/meBookings")(router);
require("./customers/meMemberships")(router);
require("./customers/mePackages")(router);
require("./customers/admin")(router);

module.exports = router;
