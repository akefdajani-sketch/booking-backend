// routes/tenantHomeLanding.js
// Tenant-scoped Home landing content (Booking "Home" tab content)
// Stored at tenants.branding.homeLanding (JSONB)
//
// Tenant endpoints (slug scoped):
//   GET /api/tenant/:slug/home-landing
//   PUT /api/tenant/:slug/home-landing
//
// Auth:
//   - Google (tenant staff) OR ADMIN_API_KEY (owner proxy-admin)
// Permissions:
//   - GET: viewer+
//   - PUT: owner+ (requires setup_write via role rules)

const express = require("express");
const router = express.Router();

const db = require("../db");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const requireAdmin = require("../middleware/requireAdmin");
const ensureUser = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole } = require("../middleware/requireTenantRole");

// Same admin-detection logic used in tenantUsers.js (kept local to avoid circular deps)
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

function requireTenantMeAuth(req, res, next) {
  if (isAdminRequest(req)) return requireAdmin(req, res, next);
  return requireGoogleAuth(req, res, next);
}

function maybeEnsureUser(req, res, next) {
  if (isAdminRequest(req)) return next();
  return ensureUser(req, res, next);
}

async function resolveTenantIdFromParam(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug." });

    const tenantId = await getTenantIdFromSlug(db, slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found." });

    req.tenantId = tenantId;
    req.tenantSlug = slug;
    return next();
  } catch (err) {
    console.error("resolveTenantIdFromParam error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET home landing (viewer+)
router.get(
  "/:slug/home-landing",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requireTenantRole("viewer"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const r = await db.query(
        `
        SELECT
          COALESCE(branding, '{}'::jsonb) #> '{homeLanding}' AS home_landing,
          currency_code
        FROM tenants
        WHERE id = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const row = r.rows[0] || {};
      return res.json({
        tenantId,
        tenantSlug: req.tenantSlug,
        currencyCode: row.currency_code || null,
        homeLanding: row.home_landing || {},
      });
    } catch (err) {
      console.error("tenant home-landing GET error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PUT home landing (owner+)
router.put(
  "/:slug/home-landing",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const homeLanding = req.body?.homeLanding;

      if (homeLanding == null || typeof homeLanding !== "object") {
        return res.status(400).json({ error: "homeLanding must be an object." });
      }

      const r = await db.query(
        `
        UPDATE tenants
        SET branding = COALESCE(branding, '{}'::jsonb) || jsonb_build_object('homeLanding', $2::jsonb),
            updated_at = NOW()
        WHERE id = $1
        RETURNING COALESCE(branding, '{}'::jsonb) #> '{homeLanding}' AS home_landing
        `,
        [tenantId, JSON.stringify(homeLanding)]
      );

      const row = r.rows[0] || {};
      return res.json({
        tenantId,
        tenantSlug: req.tenantSlug,
        homeLanding: row.home_landing || {},
        ok: true,
      });
    } catch (err) {
      console.error("tenant home-landing PUT error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
