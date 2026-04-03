// routes/tenantStaffSchedule.js
//
// Thin orchestrator — mounts staff schedule sub-files onto a shared router.
//
//   schedule.js   — GET/PUT /:slug/staff/:staffId/schedule
//   exceptions.js — GET/POST/DELETE /:slug/staff/:staffId/exceptions
//
// Shared helpers → utils/staffScheduleHelpers.js

const express = require("express");
const router  = express.Router();

require("./tenantStaffSchedule/schedule")(router);
require("./tenantStaffSchedule/exceptions")(router);

module.exports = router;
