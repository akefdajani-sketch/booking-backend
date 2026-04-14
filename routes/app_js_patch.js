// app.js — PR-TAX-1 PATCH
//
// Apply these two targeted changes to the existing app.js file.
// Do NOT rewrite the whole file — only add these lines in the locations described.
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 1: Add require() calls near the other tenantXxx route requires
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND this block (around line 50-55):
//   const tenantWhatsAppSettingsRouter = require("./routes/tenantWhatsAppSettings");
//   const reminderJobRouter = require("./routes/reminderJob");
//   const publicPricingRouter = require("./routes/publicPricing");
//
// ADD immediately after the tenantWhatsAppSettingsRouter line:
//
//   // PR-TAX-1: Tax & service charge configuration
//   const tenantTaxRouter = require("./routes/tenantTax");
//   const { publicTaxRouter } = require("./routes/tenantTax");
//
//
// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 2: Mount the routes
// ─────────────────────────────────────────────────────────────────────────────
//
// FIND this block in the app.use() section:
//   app.use("/api/tenant", tenantWhatsAppSettingsRouter); // WA-1
//   app.use("/api/reminder-job", reminderJobRouter);
//   app.use("/api/public", publicApiLimiter, publicPricingRouter);
//
// ADD after the tenantWhatsAppSettingsRouter line:
//
//   app.use("/api/tenant", tenantTaxRouter);              // PR-TAX-1: tax config CRUD
//
// ADD after the publicPricingRouter line:
//
//   app.use("/api/public", publicApiLimiter, publicTaxRouter); // PR-TAX-1: public tax-info
//
//
// ─────────────────────────────────────────────────────────────────────────────
// END OF PATCH
// ─────────────────────────────────────────────────────────────────────────────
//
// Final mounted routes added:
//   GET  /api/tenant/:slug/tax-config   (owner only)
//   PUT  /api/tenant/:slug/tax-config   (owner only)
//   GET  /api/public/:slug/tax-info     (public, rate-limited)

module.exports = {};
