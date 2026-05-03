// routes/bookings.js
//
// Thin orchestrator — mounts booking sub-files onto a shared router.
//
//   history.js — GET / (customer self-service booking history)
//   crud.js    — GET list, GET count, GET /:id, PATCH /:id/status, DELETE /:id
//   create.js  — POST / (booking creation engine with prepaid/membership logic)
//
// Shared helpers → utils/bookingRouteHelpers.js

const express = require("express");
const router  = express.Router();

require("./bookings/history")(router);
require("./bookings/crud")(router);
require("./bookings/create")(router);
require("./bookings/confirmPayment")(router); // CLIQ-CONFIRM-1: operator marks payment received

module.exports = router;
