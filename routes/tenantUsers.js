// routes/tenantUsers.js
// Tenant Users & Roles (v1)
//
// Endpoints (tenant slug scoped):
//   GET    /api/tenant/:slug/me
//   GET    /api/tenant/:slug/users
//   POST   /api/tenant/:slug/users/invite
//   GET    /api/tenant/:slug/users/invites
//   DELETE /api/tenant/:slug/users/invites/:inviteId
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
const requireAdmin = require("../middleware/requireAdmin");
const ensureUser = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { validateTenantPublish } = require("../../utils/publish");
const { requireTenantRole, normalizeRole } = require("../middleware/requireTenantRole");

const ALLOWED_ROLES = new Set(["owner", "manager", "staff", "viewer"]);

function isAdminRequest(req) {
  const expected = String(process.env.ADMIN_API_KEY || "").trim();
  if (!expected) return false;

  const rawAuth = String(req.headers.authorization || "");
  const bearer = rawAuth.toLowerCase().startsWith("bearer ")
    ? rawAuth.slice(7).trim()
    : "";

  const key =
    String(bearer || "").trim() ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"] || "").trim();

  return !!key && key === expected;
}

// For GET /me only: allow either Google (tenant staff) OR ADMIN_API_KEY (owner proxy-admin).
function requireTenantMeAuth(req, res, next) {
  if (isAdminRequest(req)) return requireAdmin(req, res, next);
  return requireGoogleAuth(req, res, next);
}

function maybeEnsureUser(req, res, next) {
  if (isAdminRequest(req)) return next();
  return ensureUser(req, res, next);
}

const requireViewerRole = requireTenantRole("viewer");
function maybeRequireViewerRole(req, res, next) {
  if (isAdminRequest(req)) return next();
  return requireViewerRole(req, res, next);
}

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

function toIso(d) {
  try {
    return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  } catch {
    return null;
  }
}

function computeInviteStatus(invite) {
  if (invite.accepted_at) return "accepted";
  const exp = new Date(invite.expires_at);
  if (Number.isFinite(exp.getTime()) && Date.now() > exp.getTime()) return "expired";
  return "pending";
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
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  maybeRequireViewerRole,
  async (req, res) => {
    // Owner proxy-admin calls this endpoint using ADMIN_API_KEY (no Google login).
    // In that mode, we treat the caller as an "owner" with full capabilities.
    if (isAdminRequest(req)) {
      return res.json({
        tenant: { id: req.tenantId, slug: req.tenantSlug },
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
    return res.json({
      tenant: { id: req.tenantId, slug: req.tenantSlug },
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

      // If there is an existing *unaccepted* invite for this email, revoke it so we
      // don't end up with multiple valid tokens floating around.
      await db.query(
        `
        DELETE FROM tenant_invites
        WHERE tenant_id = $1 AND lower(email) = $2 AND accepted_at IS NULL
        `,
        [req.tenantId, email]
      );

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
// GET /api/tenant/:slug/users/invites
// Lists invites for a tenant
// Query:
//   - status: pending|expired|accepted|all (default: pending)
//   - limit: default 50
//   - offset: default 0
// -----------------------------------------------------------------------------
router.get(
  "/:slug/users/invites",
  requireGoogleAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const status = String(req.query?.status || "pending").trim().toLowerCase();
      const limit = Math.min(Math.max(Number(req.query?.limit || 50), 1), 200);
      const offset = Math.max(Number(req.query?.offset || 0), 0);

      let where = `WHERE ti.tenant_id = $1`;
      const params = [req.tenantId];

      if (status === "pending") {
        where += ` AND ti.accepted_at IS NULL AND ti.expires_at > now()`;
      } else if (status === "expired") {
        where += ` AND ti.accepted_at IS NULL AND ti.expires_at <= now()`;
      } else if (status === "accepted") {
        where += ` AND ti.accepted_at IS NOT NULL`;
      } else if (status === "all") {
        // no-op
      } else {
        return res.status(400).json({ error: "Invalid status filter." });
      }

      const q = await db.query(
        `
        SELECT
          ti.id,
          ti.email,
          ti.role,
          ti.expires_at,
          ti.accepted_at,
          ti.created_at,
          ti.invited_by_user_id,
          u.email AS invited_by_email,
          u.full_name AS invited_by_full_name
        FROM tenant_invites ti
        LEFT JOIN users u ON u.id = ti.invited_by_user_id
        ${where}
        ORDER BY ti.created_at DESC
        LIMIT $2 OFFSET $3
        `,
        [req.tenantId, limit, offset]
      );

      const invites = (q.rows || []).map((r) => ({
        id: Number(r.id),
        email: String(r.email),
        role: String(r.role),
        status: computeInviteStatus(r),
        expires_at: toIso(r.expires_at),
        accepted_at: r.accepted_at ? toIso(r.accepted_at) : null,
        created_at: toIso(r.created_at),
        invited_by: r.invited_by_user_id
          ? {
              user_id: Number(r.invited_by_user_id),
              email: r.invited_by_email ? String(r.invited_by_email) : null,
              full_name: r.invited_by_full_name ? String(r.invited_by_full_name) : null,
            }
          : null,
      }));

      return res.json({
        tenant: { id: req.tenantId, slug: req.tenantSlug },
        invites,
        paging: { limit, offset, returned: invites.length },
      });
    } catch (err) {
      console.error("List invites error:", err);
      return res.status(500).json({ error: "Failed to load invites." });
    }
  }
);

// -----------------------------------------------------------------------------
// POST /api/tenant/:slug/users/invites/:inviteId/resend
// Rotates token + extends expiry for a pending/expired invite.
// (Email sending can be added later; we return an invite_url.)
// Optional Body: { role }  (lets owner change role before acceptance)
// -----------------------------------------------------------------------------
router.post(
  "/:slug/users/invites/:inviteId/resend",
  requireGoogleAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const inviteId = Number(req.params.inviteId);
      if (!Number.isFinite(inviteId) || inviteId <= 0) {
        return res.status(400).json({ error: "Invalid inviteId." });
      }

      const roleRaw = req.body?.role != null ? String(req.body.role).trim() : null;
      const role = roleRaw ? normalizeRole(roleRaw) : null;
      if (roleRaw && (!role || !ALLOWED_ROLES.has(role))) {
        return res.status(400).json({ error: "Invalid role." });
      }

      const found = await db.query(
        `
        SELECT id, tenant_id, email, role, expires_at, accepted_at
        FROM tenant_invites
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1
        `,
        [inviteId, req.tenantId]
      );
      if (!found.rows.length) {
        return res.status(404).json({ error: "Invite not found." });
      }

      const inv = found.rows[0];
      if (inv.accepted_at) {
        return res.status(400).json({ error: "Invite already accepted." });
      }

      // Rotate token (store only hash)
      const token = base64Url(crypto.randomBytes(32));
      const tokenHash = sha256Hex(token);
      const expiresDays = Number(process.env.INVITE_EXPIRES_DAYS || 7);
      const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000);

      const upd = await db.query(
        `
        UPDATE tenant_invites
        SET token_hash = $3,
            expires_at = $4,
            role = COALESCE($5, role),
            invited_by_user_id = $6
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, email, role, expires_at
        `,
        [inviteId, req.tenantId, tokenHash, expiresAt.toISOString(), role, req.user.id]
      );

      const base = String(process.env.FRONTEND_BASE_URL || "").replace(/\/$/, "");
      const inviteUrl = base ? `${base}/invite?token=${token}` : null;

      return res.json({
        ok: true,
        invite: {
          id: Number(upd.rows[0].id),
          email: String(upd.rows[0].email),
          role: String(upd.rows[0].role),
          expires_at: upd.rows[0].expires_at,
          invite_url: inviteUrl,
          token: inviteUrl ? undefined : token,
        },
      });
    } catch (err) {
      if (err && err.code === "23505") {
        return res.status(500).json({ error: "Please try again." });
      }
      console.error("Resend invite error:", err);
      return res.status(500).json({ error: "Failed to resend invite." });
    }
  }
);

// -----------------------------------------------------------------------------
// DELETE /api/tenant/:slug/users/invites/:inviteId
// Revokes an invite (delete row). Safe even if already expired.
// -----------------------------------------------------------------------------
router.delete(
  "/:slug/users/invites/:inviteId",
  requireGoogleAuth,
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
