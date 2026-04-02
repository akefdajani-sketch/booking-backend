// routes/tenantPrepaidAccounting.js
//
// Thin orchestrator — mounts prepaid accounting sub-files onto a shared router.
//
//   products.js      — GET/POST/PATCH /:slug/prepaid-products
//   entitlements.js  — GET /:slug/prepaid-entitlements, POST grant, POST adjust
//   ledger.js        — GET transactions, GET redemptions, POST redemption, GET accounting-summary
//
// Shared helpers (middleware, normalizers, constants) → utils/prepaidAccountingHelpers.js

const express = require("express");
const router  = express.Router();

require("./tenantPrepaidAccounting/products")(router);
require("./tenantPrepaidAccounting/entitlements")(router);
require("./tenantPrepaidAccounting/ledger")(router);

module.exports = router;
