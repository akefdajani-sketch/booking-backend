// middleware/requireTenantRole.js
// Tenant-scoped RBAC enforcement.
//
// Requires:
//   - req.tenantId (number)
//   - req.user (object with { id, email })
//
// Recommended wiring:
//   router.get(..., requireGoogleAuth, ensureUser, requireTenantRole('viewer'), handler)

const db = require("../db");

const ROLE_RANK = {
  viewer: 1,
  staff: 2,
  manager: 3,
  owner: 4,
};

function normalizeRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return ROLE_RANK[r] ? r : null;
}

async function fetchTenantRole(tenantId, userId) {
  const q = await db.query(
    `SELECT role FROM tenant_users WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
    [tenantId, userId]
  );
  return q.rows?.[0]?.role ? String(q.rows[0].role) : null;
}

function requireTenantRole(minRole) {
  const required = normalizeRole(minRole);
  if (!required) {
    throw new Error(`Invalid minRole passed to requireTenantRole: ${minRole}`);
  }

  return async function (req, res, next) {
    try {
      const tenantId = Number(req.tenantId);
      const userId = Number(req.user?.id);

      if (!Number.isFinite(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: "Missing tenant context." });
      }
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).json({ error: "Unauthenticated." });
      }

      const role = await fetchTenantRole(tenantId, userId);
      const normalized = normalizeRole(role);

      if (!normalized) {
        return res.status(403).json({ error: "No access to this tenant." });
      }

      const ok = ROLE_RANK[normalized] >= ROLE_RANK[required];
      if (!ok) {
        return res.status(403).json({ error: "Forbidden." });
      }

      req.tenantRole = normalized;
      return next();
    } catch (err) {
      console.error("requireTenantRole error:", err);
      return res.status(500).json({ error: "Failed to authorize." });
    }
  };
}

module.exports = {
  ROLE_RANK,
  normalizeRole,
  requireTenantRole,
};
