// middleware/requireTenant.js
const { getTenantIdFromSlug } = require("../utils/tenants");

async function requireTenant(req, res, next) {
  try {
    const tenantSlug = req.query?.tenantSlug ? String(req.query.tenantSlug).trim() : "";
    const tenantIdRaw = req.query?.tenantId;

    let tenantId = null;

    if (tenantSlug) {
      tenantId = await getTenantIdFromSlug(tenantSlug);
      if (!tenantId) return res.status(400).json({ error: "Unknown tenant." });

      if (tenantIdRaw != null && String(tenantIdRaw).trim() !== "") {
        const tid = Number(tenantIdRaw);
        if (!Number.isFinite(tid) || tid <= 0) {
          return res.status(400).json({ error: "Invalid tenantId." });
        }
        if (Number(tid) !== Number(tenantId)) {
          return res.status(400).json({ error: "Tenant mismatch." });
        }
      }
    } else if (tenantIdRaw != null && String(tenantIdRaw).trim() !== "") {
      const tid = Number(tenantIdRaw);
      if (!Number.isFinite(tid) || tid <= 0) {
        return res.status(400).json({ error: "Invalid tenantId." });
      }
      tenantId = tid;
    } else {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId." });
    }

    req.tenantId = Number(tenantId);
    return next();
  } catch (err) {
    console.error("requireTenant error:", err);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

module.exports = { requireTenant };
