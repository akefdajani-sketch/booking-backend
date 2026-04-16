// routes/invites.js
// Invite acceptance flow.
//
// POST /api/invites/accept
// Body: { token }
//
// Requires App auth so the invite can only be accepted by the invited email.
// If the invite has a staff_id, auto-links staff.user_id on acceptance.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const db = require("../db");
const requireAppAuth = require("../middleware/requireAppAuth");
const ensureUser = require("../middleware/ensureUser");
const { ensureRbacTables } = require("../utils/rbac");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

// -----------------------------------------------------------------------------
// POST /api/invites/accept
// -----------------------------------------------------------------------------
router.post("/accept", requireAppAuth, ensureUser, async (req, res) => {
  try {
    await ensureRbacTables();
    const token = String(req.body?.token || req.query?.token || "").trim();
    if (!token) return res.status(400).json({ error: "Missing token." });

    const tokenHash = sha256Hex(token);

    const invQ = await db.query(
      `
      SELECT
        id,
        tenant_id,
        email,
        role,
        expires_at,
        accepted_at,
        staff_id
      FROM tenant_invites
      WHERE token_hash = $1
      LIMIT 1
      `,
      [tokenHash]
    );

    if (!invQ.rows.length) {
      return res.status(404).json({ error: "Invite not found." });
    }

    const invite = invQ.rows[0];
    if (invite.accepted_at) {
      return res.status(400).json({ error: "Invite already accepted." });
    }

    const exp = new Date(invite.expires_at);
    if (Number.isFinite(exp.getTime()) && Date.now() > exp.getTime()) {
      return res.status(400).json({ error: "Invite expired." });
    }

    const invitedEmail = String(invite.email || "").trim().toLowerCase();
    const callerEmail = String(req.user.email || "").trim().toLowerCase();
    if (invitedEmail && invitedEmail !== callerEmail) {
      return res.status(403).json({ error: "This invite is for a different email." });
    }

    const tenantId = Number(invite.tenant_id);
    const userId = Number(req.user.id);
    const role = String(invite.role || "viewer");
    const staffId = invite.staff_id ? Number(invite.staff_id) : null;

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Add / update tenant_users membership (legacy table)
      await client.query(
        `
        INSERT INTO tenant_users (tenant_id, user_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, updated_at = now()
        `,
        [tenantId, userId, role]
      );

      // 2. Add tenant_user_roles entry (new RBAC table) — map role string to role_id
      const roleMapping = {
        owner: "TENANT_OWNER",
        manager: "MANAGER",
        staff: "STAFF",
        viewer: "READ_ONLY",
      };
      const roleKey = roleMapping[role] || "READ_ONLY";
      const roleRow = await client.query(
        `SELECT id FROM roles WHERE key = $1 LIMIT 1`,
        [roleKey]
      );
      if (roleRow.rows.length) {
        await client.query(
          `
          INSERT INTO tenant_user_roles (tenant_id, user_id, role_id, is_primary)
          VALUES ($1, $2, $3, false)
          ON CONFLICT (tenant_id, user_id)
          DO UPDATE SET role_id = EXCLUDED.role_id
          `,
          [tenantId, userId, Number(roleRow.rows[0].id)]
        );
      }

      // 3. If invite was for a specific staff member, link staff.user_id
      if (staffId) {
        await client.query(
          `UPDATE staff SET user_id = $1 WHERE id = $2 AND tenant_id = $3 AND user_id IS NULL`,
          [userId, staffId, tenantId]
        );
      }

      // 4. Mark invite accepted
      await client.query(
        `UPDATE tenant_invites SET accepted_at = now() WHERE id = $1`,
        [Number(invite.id)]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Find slug for frontend redirect convenience
    const tQ = await db.query(
      `SELECT slug FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );

    return res.json({
      ok: true,
      tenant_id: tenantId,
      tenant_slug: tQ.rows?.[0]?.slug || null,
      role,
      staff_id: staffId,
    });
  } catch (err) {
    console.error("Accept invite error:", err);
    return res.status(500).json({ error: "Failed to accept invite." });
  }
});

module.exports = router;
