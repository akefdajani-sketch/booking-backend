// routes/tenantStaffPortal.js
//
// Staff Portal Access — invite a staff member to log in and link their account.
//
// Endpoints:
//   POST /api/tenant/:slug/staff/:staffId/portal-invite
//   GET  /api/tenant/:slug/staff/:staffId/portal-status
//   GET  /api/tenant/:slug/staff/portal-statuses   (bulk, for the staff list UI)
//
// Flow:
//   1. Owner opens a staff profile → sees Portal Access card
//   2. Owner fills in email + clicks "Invite to Portal"
//   3. This route creates a tenant_invites row with role='staff' and staff_id=staffId
//   4. Returns an invite_url the owner can copy/share
//   5. When the specialist accepts (via /api/invites/accept):
//      - staff.user_id gets set
//      - tenant_users + tenant_user_roles rows created
//
// Auth: requireAppAuth + ensureUser + requireTenantRole('owner','manager')

"use strict";

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const db = require("../db");
const requireAppAuth = require("../middleware/requireAppAuth");
const ensureUser = require("../middleware/ensureUser");
const { requireTenantRole } = require("../middleware/requireTenantRole");
const { requireTenant } = require("../middleware/requireTenant");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}
function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Inject tenantSlug for requireTenant
function injectSlug(req, _res, next) {
  req.query = req.query || {};
  req.query.tenantSlug = req.params.slug;
  next();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getStaffInTenant(tenantId, staffId) {
  const r = await db.query(
    `SELECT id, name, user_id FROM staff WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [staffId, tenantId]
  );
  return r.rows[0] || null;
}

async function getPortalStatus(tenantId, staffId) {
  // Pending invite
  const inv = await db.query(
    `SELECT id, email, expires_at, accepted_at
     FROM tenant_invites
     WHERE tenant_id = $1 AND staff_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, staffId]
  );

  // Linked user
  const linked = await db.query(
    `SELECT s.user_id, u.email, u.full_name
     FROM staff s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.tenant_id = $2 LIMIT 1`,
    [staffId, tenantId]
  );

  const staffRow = linked.rows[0];
  const isLinked = !!staffRow?.user_id;
  const invite = inv.rows[0] || null;

  let status = "not_linked";
  if (isLinked) {
    status = "active";
  } else if (invite && !invite.accepted_at && new Date(invite.expires_at) > new Date()) {
    status = "invite_pending";
  } else if (invite && !invite.accepted_at) {
    status = "invite_expired";
  }

  return {
    status,
    linked_user_id: staffRow?.user_id || null,
    linked_email: staffRow?.user_id ? (staffRow.email || null) : null,
    linked_full_name: staffRow?.user_id ? (staffRow.full_name || null) : null,
    pending_invite: invite && status === "invite_pending"
      ? { id: Number(invite.id), email: invite.email, expires_at: invite.expires_at }
      : null,
  };
}

// ─── POST /api/tenant/:slug/staff/:staffId/portal-invite ─────────────────────

router.post(
  "/:slug/staff/:staffId/portal-invite",
  requireAppAuth,
  ensureUser,
  injectSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const staffId = Number(req.params.staffId);
      if (!Number.isFinite(staffId) || staffId <= 0) {
        return res.status(400).json({ error: "Invalid staffId." });
      }

      const email = String(req.body?.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        return res.status(400).json({ error: "Valid email is required." });
      }

      const staff = await getStaffInTenant(tenantId, staffId);
      if (!staff) return res.status(404).json({ error: "Staff not found." });

      if (staff.user_id) {
        return res.status(409).json({ error: "Staff already has a linked account." });
      }

      // Check if this email is already a tenant member
      const existingMember = await db.query(
        `SELECT 1 FROM tenant_users tu
         JOIN users u ON u.id = tu.user_id
         WHERE tu.tenant_id = $1 AND lower(u.email) = $2 LIMIT 1`,
        [tenantId, email]
      );
      if (existingMember.rows.length) {
        // If already a member, just link the staff record to them
        const userRow = await db.query(
          `SELECT id FROM users WHERE lower(email) = $1 LIMIT 1`,
          [email]
        );
        if (userRow.rows.length) {
          await db.query(
            `UPDATE staff SET user_id = $1 WHERE id = $2 AND tenant_id = $3`,
            [userRow.rows[0].id, staffId, tenantId]
          );
          return res.json({
            ok: true,
            linked: true,
            message: "User was already a team member — staff record linked directly.",
          });
        }
      }

      // Revoke any prior pending invite for this staff member
      await db.query(
        `DELETE FROM tenant_invites WHERE tenant_id = $1 AND staff_id = $2 AND accepted_at IS NULL`,
        [tenantId, staffId]
      );

      const token = base64Url(crypto.randomBytes(32));
      const tokenHash = sha256Hex(token);
      const expiresDays = Number(process.env.INVITE_EXPIRES_DAYS || 7);
      const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000);

      const ins = await db.query(
        `INSERT INTO tenant_invites
           (tenant_id, email, role, token_hash, expires_at, invited_by_user_id, staff_id)
         VALUES ($1, $2, 'staff', $3, $4, $5, $6)
         RETURNING id, email, role, expires_at`,
        [tenantId, email, tokenHash, expiresAt.toISOString(), req.user.id, staffId]
      );

      const base = String(process.env.FRONTEND_BASE_URL || "").replace(/\/$/, "");
      const inviteUrl = base ? `${base}/invite?token=${token}` : null;

      return res.status(201).json({
        ok: true,
        invite: {
          id: Number(ins.rows[0].id),
          email: String(ins.rows[0].email),
          role: String(ins.rows[0].role),
          expires_at: ins.rows[0].expires_at,
          invite_url: inviteUrl,
          token: inviteUrl ? undefined : token,
        },
      });
    } catch (err) {
      if (err?.code === "23505") return res.status(500).json({ error: "Please try again." });
      console.error("Staff portal invite error:", err);
      return res.status(500).json({ error: "Failed to create staff portal invite." });
    }
  }
);

// ─── GET /api/tenant/:slug/staff/:staffId/portal-status ──────────────────────

router.get(
  "/:slug/staff/:staffId/portal-status",
  requireAppAuth,
  ensureUser,
  injectSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const staffId = Number(req.params.staffId);
      if (!Number.isFinite(staffId) || staffId <= 0) {
        return res.status(400).json({ error: "Invalid staffId." });
      }

      const staff = await getStaffInTenant(tenantId, staffId);
      if (!staff) return res.status(404).json({ error: "Staff not found." });

      const portalStatus = await getPortalStatus(tenantId, staffId);
      return res.json({ staff_id: staffId, ...portalStatus });
    } catch (err) {
      console.error("Staff portal status error:", err);
      return res.status(500).json({ error: "Failed to load portal status." });
    }
  }
);

// ─── GET /api/tenant/:slug/staff/portal-statuses (bulk) ─────────────────────

router.get(
  "/:slug/staff/portal-statuses",
  requireAppAuth,
  ensureUser,
  injectSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);

      // Get all staff with their linked user info
      const staffRows = await db.query(
        `SELECT s.id, s.name, s.user_id, u.email as linked_email
         FROM staff s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.tenant_id = $1 AND s.is_active = true
         ORDER BY s.name`,
        [tenantId]
      );

      // Get latest pending invites per staff
      const inviteRows = await db.query(
        `SELECT DISTINCT ON (staff_id)
           staff_id, id, email, expires_at, accepted_at
         FROM tenant_invites
         WHERE tenant_id = $1 AND staff_id IS NOT NULL
         ORDER BY staff_id, created_at DESC`,
        [tenantId]
      );

      const inviteMap = {};
      for (const inv of inviteRows.rows) {
        inviteMap[inv.staff_id] = inv;
      }

      const statuses = staffRows.rows.map((s) => {
        const invite = inviteMap[s.id];
        let status = "not_linked";
        if (s.user_id) {
          status = "active";
        } else if (invite && !invite.accepted_at && new Date(invite.expires_at) > new Date()) {
          status = "invite_pending";
        } else if (invite && !invite.accepted_at) {
          status = "invite_expired";
        }
        return {
          staff_id: Number(s.id),
          name: s.name,
          status,
          linked_email: s.user_id ? (s.linked_email || null) : null,
          pending_invite_email: status === "invite_pending" ? invite.email : null,
        };
      });

      return res.json({ statuses });
    } catch (err) {
      console.error("Staff portal statuses error:", err);
      return res.status(500).json({ error: "Failed to load portal statuses." });
    }
  }
);

// ─── DELETE /api/tenant/:slug/staff/:staffId/portal-link (unlink) ─────────────

router.delete(
  "/:slug/staff/:staffId/portal-link",
  requireAppAuth,
  ensureUser,
  injectSlug,
  requireTenant,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const staffId = Number(req.params.staffId);

      const staff = await getStaffInTenant(tenantId, staffId);
      if (!staff) return res.status(404).json({ error: "Staff not found." });

      await db.query(
        `UPDATE staff SET user_id = NULL WHERE id = $1 AND tenant_id = $2`,
        [staffId, tenantId]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("Staff portal unlink error:", err);
      return res.status(500).json({ error: "Failed to unlink." });
    }
  }
);

module.exports = router;
