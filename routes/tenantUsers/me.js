// routes/tenantUsers/me.js
// GET /:slug/me, GET /:slug/publish-status, GET /:slug/users
// Mounted by routes/tenantUsers.js

const db = require("../../db");
const crypto = require("crypto");
const requireAppAuth = require("../../middleware/requireAppAuth");
const requireAdmin   = require("../../middleware/requireAdmin");
const ensureUser     = require("../../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../../utils/tenants");
const { validateTenantPublish } = require("../../utils/publish");
const { requireTenantRole, normalizeRole } = require("../../middleware/requireTenantRole");
const {
  isAdminRequest, requireTenantMeAuth, maybeEnsureUser, maybeRequireViewerRole,
  getTenantMeColumnSet, tenantMeSelectExpr, getTenantDetail, resolveTenantIdFromParam,
  sha256Hex, base64Url, toIso, computeInviteStatus, countOwners,
} = require("../../utils/tenantUsersHelpers");


module.exports = function mount(router) {
router.get(
  "/:slug/me",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  maybeRequireViewerRole,
  async (req, res) => {
    // Owner proxy-admin calls this endpoint using ADMIN_API_KEY (no Google login).
    // In that mode, we treat the caller as an "owner" with full capabilities.
    if (isAdminRequest(req)) {
      const tenant = await getTenantDetail(req.tenantId, req.tenantSlug);
      return res.json({
        tenant: tenant || { id: req.tenantId, slug: req.tenantSlug },
        user: null,
        role: "owner",
        can: {
          bookings_read: true,
          bookings_write: true,
          customers_read: true,
          customers_write: true,
          setup_write: true,
          appearance_write: true,
          plan_billing_write: true,
          users_roles_write: true,
        },
      });
    }

    const role = req.tenantRole;
    const can = {
      bookings_read: true,
      // Operational actions (staff can create/manage bookings and customers)
      bookings_write: role === "owner" || role === "manager" || role === "staff",
      customers_read: true,
      customers_write: role === "owner" || role === "manager" || role === "staff",
      // Setup & configuration: keep delegated to owner/manager only
      setup_write: role === "owner" || role === "manager",
      // Theme Studio / Appearance: owner only (employees cannot access)
      appearance_write: role === "owner",
      plan_billing_write: role === "owner",
      users_roles_write: role === "owner",
    };
    const tenant = await getTenantDetail(req.tenantId, req.tenantSlug);
    return res.json({
      tenant: tenant || { id: req.tenantId, slug: req.tenantSlug },
      user: {
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.full_name,
      },
      role,
      can,
    });
  }
);

// -----------------------------------------------------------------------------
// GET /api/tenant/:slug/publish-status
// Tenant-accessible publish readiness/status.
// This avoids forcing tenant staff flows to call the platform-admin-only
// /api/tenants/publish-status endpoint.
// -----------------------------------------------------------------------------

// GET /api/tenant/:slug/publish-status
// Tenant-accessible publish readiness/status.
// IMPORTANT: This does NOT require platform admin.
// It is safe for tenant staff/owners (Google auth) and also works via
// server-side admin proxy for platform owner flows.
// -----------------------------------------------------------------------------
router.get(
  "/:slug/publish-status",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  maybeRequireViewerRole,
  async (req, res) => {
    try {
      const status = await validateTenantPublish(db, req.tenantId);
      return res.json({ tenantId: req.tenantId, tenantSlug: req.tenantSlug, ...status });
    } catch (err) {
      console.error("Tenant publish-status error:", err);
      return res.status(500).json({ error: "Failed to load publish status." });
    }
  }
);

// -----------------------------------------------------------------------------
// GET /api/tenant/:slug/users
// Lists users for a tenant
// -----------------------------------------------------------------------------
router.get(
  "/:slug/users",
  requireAppAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("viewer"),
  async (req, res) => {
    try {
      const q = await db.query(
        `
        SELECT
          u.id,
          u.email,
          u.full_name,
          u.status,
          tu.role,
          tu.is_primary,
          tu.created_at
        FROM tenant_users tu
        JOIN users u ON u.id = tu.user_id
        WHERE tu.tenant_id = $1
        ORDER BY
          CASE tu.role
            WHEN 'owner' THEN 1
            WHEN 'manager' THEN 2
            WHEN 'staff' THEN 3
            WHEN 'viewer' THEN 4
            ELSE 99
          END,
          u.email ASC
        `,
        [req.tenantId]
      );

      return res.json({
        tenant: { id: req.tenantId, slug: req.tenantSlug },
        users: q.rows || [],
      });
    } catch (err) {
      console.error("List tenant users error:", err);
      return res.status(500).json({ error: "Failed to load users." });
    }
  }
);

// -----------------------------------------------------------------------------
// POST /api/tenant/:slug/users/invite
// Creates an invite. (Email sending can be added later.)
// Body: { email, role }
// -----------------------------------------------------------------------------
};
