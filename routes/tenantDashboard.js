// routes/tenantDashboard.js
// Tenant Dashboard Summary (PR-TD2)
//
// Endpoint:
//   GET /api/tenant/:slug/dashboard-summary?mode=day|week|month&date=YYYY-MM-DD
//
// Auth:
//   requireGoogleAuth + ensureUser + requireTenant + requireTenantRole('viewer')
//
// Notes:
// - Strict tenant isolation: all reads are scoped by tenant_id.
// - Revenue is derived from bookings.charge_amount (stored at booking creation).

const express = require("express");

const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const ensureUser = require("../middleware/ensureUser");
const { requireTenant } = require("../middleware/requireTenant");
const { requireTenantRole } = require("../middleware/requireTenantRole");

const { getDashboardSummary } = require("../utils/dashboardSummary");

const router = express.Router();

router.get(
  "/:slug/dashboard-summary",
  requireGoogleAuth,
  ensureUser,
  // inject tenantSlug for requireTenant() resolver
  (req, _res, next) => {
    req.query = req.query || {};
    req.query.tenantSlug = req.params.slug;
    next();
  },
  requireTenant,
  requireTenantRole("viewer"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const tenantSlug = String(req.params.slug);
      const mode = String(req.query.mode || "day").toLowerCase().trim();
      const dateStr = String(req.query.date || "");

      const payload = await getDashboardSummary({ tenantId, tenantSlug, mode, dateStr });
      return res.json(payload);
    } catch (err) {
      console.error("tenant dashboard summary error:", err);
      return res.status(500).json({ error: "Failed to load dashboard summary." });
    }
  }
);

module.exports = router;
