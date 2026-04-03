// routes/services.js
//
// Thin orchestrator — mounts service sub-files onto a shared router.
//
//   crud.js   — GET/, POST/, PATCH/:id, DELETE/:id
//   images.js — POST/:id/image, DELETE/:id/image
//
// Shared helpers → utils/servicesHelpers.js

const express = require("express");
const router  = express.Router();

require("./services/crud")(router);
require("./services/images")(router);

module.exports = router;
