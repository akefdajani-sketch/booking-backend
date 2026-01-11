// routes/tenantUsers.js
// Tenant Users & Roles (v1)
//
// Endpoints (tenant slug scoped):
//   GET    /api/tenant/:slug/me
//   GET    /api/tenant/:slug/users
//   POST   /api/tenant/:slug/users/invite
//   PATCH  /api/tenant/:slug/users/:userId
//   DELETE /api/tenant/:slug/users/:userId
//
// Auth:
//   - requireGoogleAuth + ensureUser
// Permissions:
//   - viewer+ can access /me and /users
//   - owner only can invite/update/remove

const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const db = require("../db");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const ensureUser = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole, normalizeRole } = require("../middleware/requireTenantRole");

const ALLOWED_ROLES = new Set(["owner", "manager", "staff", "viewer"]);

async function resolveTenantIdFromParam(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug." });
    const tenantId = await getTenantIdFromSlug(slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found." });
    req.tenantSlug = slug;
    req.tenantId = Number(tenantId);
    return next();
  } catch (err) {
    console.error("resolveTenantIdFromParam error:", err);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function base64Url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function countOwners(tenantId) {
  const q = await db.query(
    `SELECT COUNT(*)::int AS c FROM tenant_users WHERE tenant_id = $1 AND role = 'owner'`,
    [tenantId]
  );
  return Number(q.rows?.[0]?.c || 0);
}

// -----------------------------------------------------------------------------
// GET /api/tenant/:slug/me
// Returns the caller's role in the tenant
// -----------------------------------------------------------------------------
router.get(
  "/:slug/me",
  requireGoogleAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("viewer"),
  async (req, res) => {
    return res.json({
      tenant: { id: req.tenantId, slug: req.tenantSlug },
      user: {
        id: req.user.id,
        email: req.user.email,
        full_name: req.user.full_name,
      },
      role: req.tenantRole,
    });
  }
);

// -----------------------------------------------------------------------------
// GET /api/tenant/:slug/users
// Lists users for a tenant
// -----------------------------------------------------------------------------
router.get(
  "/:slug/users",
  requireGoogleAuth,
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
router.post(
  "/:slug/users/invite",
  requireGoogleAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const roleRaw = String(req.body?.role || "viewer").trim();
      const role = normalizeRole(roleRaw) || "viewer";

      if (!email || !email.includes("@")) {
        return res.status(400).json({ error: "Invalid email." });
      }
      if (!ALLOWED_ROLES.has(role)) {
        return res.status(400).json({ error: "Invalid role." });
      }

      // If already a member, return a friendly conflict
      const exists = await db.query(
        `
        SELECT 1
        FROM tenant_users tu
        JOIN users u ON u.id = tu.user_id
        WHERE tu.tenant_id = $1 AND lower(u.email) = $2
        LIMIT 1
        `,
        [req.tenantId, email]
      );
      if (exists.rows.length) {
        return res.status(409).json({ error: "User already belongs to this tenant." });
      }

      // Create secure token (store only a hash)
      const token = base64Url(crypto.randomBytes(32));
      const tokenHash = sha256Hex(token);
      const expiresDays = Number(process.env.INVITE_EXPIRES_DAYS || 7);
      const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000);

      const ins = await db.query(
        `
        INSERT INTO tenant_invites
          (tenant_id, email, role, token_hash, expires_at, invited_by_user_id)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING id, email, role, expires_at
        `,
        [req.tenantId, email, role, tokenHash, expiresAt.toISOString(), req.user.id]
      );

      const base = String(process.env.FRONTEND_BASE_URL || "").replace(/\/$/, "");
      const inviteUrl = base
        ? `${base}/invite?token=${token}`
        : null;

      return res.status(201).json({
        ok: true,
        invite: {
          id: ins.rows[0].id,
          email: ins.rows[0].email,
          role: ins.rows[0].role,
          expires_at: ins.rows[0].expires_at,
          invite_url: inviteUrl,
          token: inviteUrl ? undefined : token, // only return raw token if no base url
        },
      });
    } catch (err) {
      // token_hash uniqueness race
      if (err && err.code === "23505") {
        return res.status(500).json({ error: "Please try again." });
      }
      console.error("Invite user error:", err);
      return res.status(500).json({ error: "Failed to create invite." });
    }
  }
);

// -----------------------------------------------------------------------------
// PATCH /api/tenant/:slug/users/:userId
// Body: { role }
// -----------------------------------------------------------------------------
router.patch(
  "/:slug/users/:userId",
  requireGoogleAuth,
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
  requireGoogleAuth,
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

module.exports = router;
