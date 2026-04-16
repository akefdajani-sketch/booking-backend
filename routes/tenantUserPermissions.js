// routes/tenantUserPermissions.js
//
// Permission overrides — get effective permissions for a user, and save overrides.
//
// Endpoints:
//   GET  /api/tenant/:slug/users/:userId/permissions
//        → returns role default perms + any saved overrides merged
//   PUT  /api/tenant/:slug/users/:userId/permissions
//        → saves overrides to tenant_user_permission_overrides
//
// Auth: requireAppAuth + owner/manager only
// Isolation: all reads/writes scoped by tenant_id

"use strict";

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAppAuth = require("../middleware/requireAppAuth");
const ensureUser = require("../middleware/ensureUser");
const { requireTenantRole } = require("../middleware/requireTenantRole");
const { requireTenant } = require("../middleware/requireTenant");

function injectSlug(req, _res, next) {
  req.query = req.query || {};
  req.query.tenantSlug = req.params.slug;
  next();
}

// All available permission keys — mirrors what's in the permissions table
const ALL_PERMISSION_KEYS = [
  "DASHBOARD_VIEW",
  "BOOKINGS_READ",
  "BOOKINGS_WRITE",
  "BOOKINGS_MODIFY",
  "BOOKINGS_CANCEL",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "MEMBERSHIPS_READ",
  "MEMBERSHIPS_WRITE",
  "LEDGER_READ",
  "LEDGER_WRITE",
  "SERVICES_READ",
  "SERVICES_WRITE",
  "RESOURCES_READ",
  "RESOURCES_WRITE",
  "STAFF_READ",
  "STAFF_WRITE",
  "TENANT_SETTINGS_READ",
  "TENANT_SETTINGS_WRITE",
  "TENANT_USERS_READ",
  "TENANT_USERS_INVITE",
  "TENANT_USERS_MANAGE",
  "BILLING_READ",
  "BILLING_WRITE",
];

// ─── GET /api/tenant/:slug/users/:userId/permissions ─────────────────────────

router.get(
  "/:slug/users/:userId/permissions",
  requireAppAuth,
  ensureUser,
  injectSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const targetUserId = Number(req.params.userId);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: "Invalid userId." });
      }

      // Get role from tenant_users
      const memberQ = await db.query(
        `SELECT tu.role, tu.is_primary,
                s.id as staff_id, s.name as staff_name
         FROM tenant_users tu
         LEFT JOIN staff s ON s.user_id = tu.user_id AND s.tenant_id = tu.tenant_id
         WHERE tu.tenant_id = $1 AND tu.user_id = $2
         LIMIT 1`,
        [tenantId, targetUserId]
      );
      if (!memberQ.rows.length) {
        return res.status(404).json({ error: "User not found in this tenant." });
      }
      const member = memberQ.rows[0];
      const roleKey = String(member.role || "viewer").toUpperCase();

      // Map old role strings to new role keys
      const roleMapping = {
        OWNER: "TENANT_OWNER",
        MANAGER: "MANAGER",
        STAFF: "STAFF",
        VIEWER: "READ_ONLY",
        TENANT_OWNER: "TENANT_OWNER",
        TENANT_ADMIN: "TENANT_ADMIN",
        READ_ONLY: "READ_ONLY",
      };
      const normalizedRoleKey = roleMapping[roleKey] || "READ_ONLY";

      // Get role default permissions
      const rolePermsQ = await db.query(
        `SELECT p.key
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE r.key = $1`,
        [normalizedRoleKey]
      );
      const roleDefaultSet = new Set(rolePermsQ.rows.map((r) => r.key));

      // Get any saved overrides for this user/tenant
      const overridesQ = await db.query(
        `SELECT permission, granted
         FROM tenant_user_permission_overrides
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, targetUserId]
      );
      const overrides = {};
      for (const row of overridesQ.rows) {
        overrides[row.permission] = Boolean(row.granted);
      }

      // Build effective permissions map
      const effective = {};
      for (const key of ALL_PERMISSION_KEYS) {
        if (overrides[key] !== undefined) {
          effective[key] = overrides[key];
        } else {
          effective[key] = roleDefaultSet.has(key);
        }
      }

      // Get user details
      const userQ = await db.query(
        `SELECT id, email, full_name FROM users WHERE id = $1 LIMIT 1`,
        [targetUserId]
      );

      return res.json({
        user: userQ.rows[0] || { id: targetUserId },
        role: member.role,
        role_key: normalizedRoleKey,
        staff_id: member.staff_id || null,
        staff_name: member.staff_name || null,
        role_defaults: Object.fromEntries(
          ALL_PERMISSION_KEYS.map((k) => [k, roleDefaultSet.has(k)])
        ),
        overrides,
        effective,
      });
    } catch (err) {
      console.error("Get permissions error:", err);
      return res.status(500).json({ error: "Failed to load permissions." });
    }
  }
);

// ─── PUT /api/tenant/:slug/users/:userId/permissions ─────────────────────────
// Body: { overrides: { BOOKINGS_WRITE: true, BOOKINGS_CANCEL: false, ... } }
// Only the keys provided are saved/updated. Others are untouched.
// Send null to clear an override (revert to role default).

router.put(
  "/:slug/users/:userId/permissions",
  requireAppAuth,
  ensureUser,
  injectSlug,
  requireTenant,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const targetUserId = Number(req.params.userId);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: "Invalid userId." });
      }

      // Confirm user belongs to this tenant
      const memberCheck = await db.query(
        `SELECT 1 FROM tenant_users WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
        [tenantId, targetUserId]
      );
      if (!memberCheck.rows.length) {
        return res.status(404).json({ error: "User not found in this tenant." });
      }

      const incoming = req.body?.overrides;
      if (!incoming || typeof incoming !== "object") {
        return res.status(400).json({ error: "overrides object is required." });
      }

      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");

        for (const [key, value] of Object.entries(incoming)) {
          if (!ALL_PERMISSION_KEYS.includes(key)) continue; // ignore unknown keys

          if (value === null || value === undefined) {
            // Clear override — revert to role default
            await client.query(
              `DELETE FROM tenant_user_permission_overrides
               WHERE tenant_id = $1 AND user_id = $2 AND permission = $3`,
              [tenantId, targetUserId, key]
            );
          } else {
            // Upsert override
            await client.query(
              `INSERT INTO tenant_user_permission_overrides
                 (tenant_id, user_id, permission, granted, created_by)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (tenant_id, user_id, permission)
               DO UPDATE SET granted = EXCLUDED.granted`,
              [tenantId, targetUserId, key, Boolean(value), req.user.id]
            );
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("Save permissions error:", err);
      return res.status(500).json({ error: "Failed to save permissions." });
    }
  }
);

module.exports = router;
