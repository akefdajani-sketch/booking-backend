// routes/adminTenantsTheme.js
//
// Thin orchestrator — mounts theme/branding sub-files onto a shared router.
//
//   theme.js    — appearance, diff, reset-to-inherit, theme-key, theme-schema CRUD, changelog, plan-summary
//   branding.js — branding save-draft/publish/rollback, banner-focal
//
// Shared helpers → utils/adminTenantsThemeHelpers.js

const express = require("express");
const router  = express.Router();

require("./adminTenantsTheme/theme")(router);
require("./adminTenantsTheme/branding")(router);

module.exports = router;
