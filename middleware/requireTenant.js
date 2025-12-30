// middleware/requireTenant.js
const { getTenantIdFromSlug } = require("../utils/tenants");

async function requireTenant(req, res, next) {
  try {
    const tenantSlug = String(req.query.tenantSlug || "").trim();
    const tenantIdRaw = req.query.tenantId;

    // Prefer slug (stable external identifier)
    let tenantId = null;

    if (tenantSlug) {
      tenantId = await getTenantIdFromSlug(tenantSlug);
      if (!tenantId) return res.status(400).json({ error: "Unknown tenant." });

      // If client also provided tenantId, it must match slug resolution
      if (tenantIdRaw != null && String(tenantIdRaw).trim() !== "" && Number(tenantIdRaw) !== Number(tenantId)) {
        return res.status(400).json({ error: "Tenant mismatch." });
      }
    } else if (tenantIdRaw != null && String(tenantIdRaw).trim() !== "") {
      tenantId = Number(tenantIdRaw);
      if (!Number.isFinite(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: "Invalid tenantId." });
      }
    } else {
      return res.status(400).json({ error: "Missing tenantSlug or tenantId." });
    }

    req.tenantId = tenantId;
    return next();
  } catch (err) {
    console.error("requireTenant error:", err);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

module.exports = { requireTenant };
