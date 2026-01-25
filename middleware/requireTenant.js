// middleware/requireTenant.js
const { getTenantIdFromSlug } = require("../utils/tenants");

async function requireTenant(req, res, next) {
  try {
    // Primary: explicit tenantSlug/tenantId passed as query/body.
    // Fallbacks (for the public booking UI routed at /book/:slug):
    // - x-tenant-slug header injected by the Next.js proxy
    // - derive slug from Referer path (/book/<slug>)
    const headerTenantSlug = (req.headers["x-tenant-slug"] || "")
      .toString()
      .trim();

    let refererTenantSlug = "";
    const referer = (req.headers.referer || req.headers.referrer || "")
      .toString()
      .trim();
    if (referer) {
      try {
        const u = new URL(referer);
        const m = u.pathname.match(/^\/book\/([^/?#]+)/i);
        if (m && m[1]) refererTenantSlug = decodeURIComponent(m[1]).trim();
      } catch (_) {
        // ignore invalid Referer
      }
    }

    const tenantSlug =
      (req.query?.tenantSlug ?? req.body?.tenantSlug ?? headerTenantSlug ?? refererTenantSlug ?? "")
        .toString()
        .trim();

    const tenantIdRaw =
      (req.query?.tenantId ?? req.body?.tenantId);

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
