// routes/bookings/history.js
// GET / (customer booking history self-service)
// Mounted by routes/bookings.js

const db = require("../../db");
const { pool } = require("../../db");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const { ensureBookingMoneyColumns } = require("../../utils/ensureBookingMoneyColumns");
const { bookingQueryBuilder } = require("../../utils/bookingQueryBuilder");
const {
  shouldUseCustomerHistory, checkBlackoutOverlap, servicesHasColumn, getServiceAllowMembership,
  getIdempotencyKey, mustHaveTenantSlug, canTransitionStatus, bumpTenantBookingChange,
  prepaidTablesExist, resolvePrepaidSelection, computePrepaidRedemptionSelection,
  loadMembershipCheckoutPolicy, roundUpMinutes, buildMembershipResolution,
  buildMembershipInsufficientPayload,
} = require("../../utils/bookingRouteHelpers");


module.exports = function mount(router) {
router.get(
  "/",
  (req, _res, next) => {
    if (shouldUseCustomerHistory(req)) return next();
    return next("route");
  },
  requireAppAuth,
  requireTenant,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const googleEmail = String(req.auth?.email || req.googleUser?.email || "").trim().toLowerCase();

      const qEmailRaw =
        (req.query.customerEmail ? String(req.query.customerEmail) : "") ||
        (req.query.customerEmailOrPhone ? String(req.query.customerEmailOrPhone) : "");
      const qEmail = String(qEmailRaw).trim().toLowerCase();

      if (!googleEmail) return res.status(401).json({ error: "Unauthorized" });
      if (qEmail && qEmail !== googleEmail) {
        return res.status(403).json({ error: "Forbidden" });
      }

      let customerId = req.query.customerId ? Number(req.query.customerId) : null;

      // If customerId provided, ensure it belongs to the signed-in Google email.
      if (customerId && Number.isFinite(customerId)) {
        const c = await db.query(
          `SELECT id, email FROM customers WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [tenantId, customerId]
        );
        if (c.rows.length === 0) return res.json({ bookings: [] });
        const rowEmail = String(c.rows[0].email || "").trim().toLowerCase();
        if (rowEmail !== googleEmail) return res.status(403).json({ error: "Forbidden" });
      } else {
        // Resolve customerId by email (preferred)
        const c = await db.query(
          `SELECT id FROM customers WHERE tenant_id = $1 AND lower(email) = $2 LIMIT 1`,
          [tenantId, googleEmail]
        );
        customerId = c.rows[0]?.id ?? null;
      }

      if (!customerId) return res.json({ bookings: [] });

      const result = await db.query(
        `
        SELECT
          b.id,
          b.start_at,
          b.end_at,
          b.status,
          s.name AS service_name,
          r.name AS resource_name
        FROM bookings b
        LEFT JOIN services s ON s.id = b.service_id
        LEFT JOIN resources r ON r.id = b.resource_id
        WHERE b.tenant_id = $1 AND b.customer_id = $2
        ORDER BY b.start_at DESC
        LIMIT 200
        `,
        [tenantId, customerId]
      );

      return res.json({ bookings: result.rows || [] });
    } catch (err) {
      console.error("Customer bookings history error:", err);
      return res.status(500).json({ error: "Failed to load bookings" });
    }
  }
);

// ADMIN: bookings list (owner dashboard)
// IMPORTANT: requireTenant must run BEFORE requireAdminOrTenantRole, because
// requireTenantRole depends on req.tenantId and will otherwise 400 "Missing tenant context."
};
