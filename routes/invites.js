// routes/invites.js
// Invite acceptance flow.
//
// POST /api/invites/accept
// Body: { token }
//
// Requires Google auth so the invite can only be accepted by the invited email.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const db = require("../db");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const ensureUser = require("../middleware/ensureUser");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

// -----------------------------------------------------------------------------
// POST /api/invites/accept
// -----------------------------------------------------------------------------
router.post("/accept", requireGoogleAuth, ensureUser, async (req, res) => {
  try {
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
        accepted_at
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

    // Add membership (idempotent)
    await db.query(
      `
      INSERT INTO tenant_users (tenant_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, user_id)
      DO UPDATE SET role = EXCLUDED.role, updated_at = now()
      `,
      [Number(invite.tenant_id), req.user.id, String(invite.role)]
    );

    await db.query(
      `UPDATE tenant_invites SET accepted_at = now() WHERE id = $1`,
      [Number(invite.id)]
    );

    // Find slug for frontend redirect convenience
    const tQ = await db.query(
      `SELECT slug FROM tenants WHERE id = $1 LIMIT 1`,
      [Number(invite.tenant_id)]
    );

    return res.json({
      ok: true,
      tenant_id: Number(invite.tenant_id),
      tenant_slug: tQ.rows?.[0]?.slug || null,
      role: String(invite.role),
    });
  } catch (err) {
    console.error("Accept invite error:", err);
    return res.status(500).json({ error: "Failed to accept invite." });
  }
});

module.exports = router;
