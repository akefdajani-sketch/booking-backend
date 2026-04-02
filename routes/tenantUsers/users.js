// routes/tenantUsers/users.js
// PATCH /:slug/users/:userId, DELETE /:slug/users/:userId
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
router.delete(
  "/:slug/users/invites/:inviteId",
  requireAppAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const inviteId = Number(req.params.inviteId);
      if (!Number.isFinite(inviteId) || inviteId <= 0) {
        return res.status(400).json({ error: "Invalid inviteId." });
      }

      const del = await db.query(
        `DELETE FROM tenant_invites WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [inviteId, req.tenantId]
      );

      if (!del.rows.length) {
        return res.status(404).json({ error: "Invite not found." });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("Revoke invite error:", err);
      return res.status(500).json({ error: "Failed to revoke invite." });
    }
  }
);

// -----------------------------------------------------------------------------
// PATCH /api/tenant/:slug/users/:userId
// Body: { role }
// -----------------------------------------------------------------------------
router.patch(
  "/:slug/users/:userId",
  requireAppAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ error: "Invalid userId." });
      }

      const roleRaw = String(req.body?.role || "").trim();
      const role = normalizeRole(roleRaw);
      if (!role || !ALLOWED_ROLES.has(role)) {
        return res.status(400).json({ error: "Invalid role." });
      }

      const current = await db.query(
        `SELECT role FROM tenant_users WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
        [req.tenantId, userId]
      );
      if (!current.rows.length) {
        return res.status(404).json({ error: "User not found in tenant." });
      }

      const wasRole = String(current.rows[0].role);
      if (wasRole === "owner" && role !== "owner") {
        const owners = await countOwners(req.tenantId);
        if (owners <= 1) {
          return res.status(400).json({ error: "Cannot demote the last owner." });
        }
      }

      const upd = await db.query(
        `
        UPDATE tenant_users
        SET role = $3, updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2
        RETURNING tenant_id, user_id, role
        `,
        [req.tenantId, userId, role]
      );

      return res.json({ ok: true, membership: upd.rows[0] });
    } catch (err) {
      console.error("Update role error:", err);
      return res.status(500).json({ error: "Failed to update role." });
    }
  }
);

// -----------------------------------------------------------------------------
// DELETE /api/tenant/:slug/users/:userId
// Removes membership
// -----------------------------------------------------------------------------
router.delete(
  "/:slug/users/:userId",
  requireAppAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ error: "Invalid userId." });
      }

      const current = await db.query(
        `SELECT role FROM tenant_users WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
        [req.tenantId, userId]
      );
      if (!current.rows.length) {
        return res.status(404).json({ error: "User not found in tenant." });
      }

      const wasRole = String(current.rows[0].role);
      if (wasRole === "owner") {
        const owners = await countOwners(req.tenantId);
        if (owners <= 1) {
          return res.status(400).json({ error: "Cannot remove the last owner." });
        }
      }

      await db.query(
        `DELETE FROM tenant_users WHERE tenant_id = $1 AND user_id = $2`,
        [req.tenantId, userId]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("Remove tenant user error:", err);
      return res.status(500).json({ error: "Failed to remove user." });
    }
  }
);
};
