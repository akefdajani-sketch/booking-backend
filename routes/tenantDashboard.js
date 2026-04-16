// routes/tenantDashboard.js
// Tenant Dashboard Summary
//
// Endpoint:
//   GET /api/tenant/:slug/dashboard-summary?mode=day|week|month&date=YYYY-MM-DD
//
// Auth:
//   requireAppAuth + ensureUser + requireTenant + requireTenantRole('viewer')
//
// Staff scoping:
//   If req.isStaffScoped = true, summary is filtered to req.staffId only.

const express = require("express");

const requireAppAuth = require("../middleware/requireAppAuth");
const ensureUser = require("../middleware/ensureUser");
const { requireTenant } = require("../middleware/requireTenant");
const { requireTenantRole } = require("../middleware/requireTenantRole");
const resolveStaffScope = require("../middleware/resolveStaffScope");

const { getDashboardSummary } = require("../utils/dashboardSummary");

const router = express.Router();

router.get(
  "/:slug/dashboard-summary",
  requireAppAuth,
  ensureUser,
  (req, _res, next) => {
    req.query = req.query || {};
    req.query.tenantSlug = req.params.slug;
    next();
  },
  requireTenant,
  requireTenantRole("viewer"),
  resolveStaffScope,
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const tenantSlug = String(req.params.slug);
      const mode = String(req.query.mode || "day").toLowerCase().trim();
      const dateStr = String(req.query.date || "");

      // Staff members only see their own KPIs
      const staffId = req.isStaffScoped ? (req.staffId || null) : null;

      const payload = await getDashboardSummary({ tenantId, tenantSlug, mode, dateStr, staffId });
      return res.json(payload);
    } catch (err) {
      console.error("tenant dashboard summary error:", err);
      return res.status(500).json({ error: "Failed to load dashboard summary." });
    }
  }
);

module.exports = router;
