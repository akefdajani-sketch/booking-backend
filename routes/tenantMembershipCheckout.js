// routes/tenantMembershipCheckout.js
// Tenant-scoped Membership checkout policy (tenant settings)
// Stored at tenants.branding.membershipCheckout (JSONB)
//
// Tenant endpoints (slug scoped):
//   GET /api/tenant/:slug/membership-checkout
//   PUT /api/tenant/:slug/membership-checkout
//
// Auth:
//   - Google (tenant staff) OR ADMIN_API_KEY (owner proxy)
// Permissions:
//   - GET: owner+
//   - PUT: owner+

const express = require("express");
const router = express.Router();

const db = require("../db");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const requireAdmin = require("../middleware/requireAdmin");
const ensureUser = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole } = require("../middleware/requireTenantRole");

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
    if (!slug) return res.status(400).json({ error: "Missing tenant slug" });

    const tenantId = await getTenantIdFromSlug(slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found" });

    req.tenantId = tenantId;
    req.tenantSlug = slug;
    return next();
  } catch (err) {
    console.error("resolveTenantIdFromParam error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

router.get(
  "/:slug/membership-checkout",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const r = await db.query(
        `
        SELECT
          COALESCE(branding, '{}'::jsonb) #> '{membershipCheckout}' AS membership_checkout,
          currency_code
        FROM tenants
        WHERE id = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const row = r.rows?.[0] || {};
      return res.json({
        tenantId,
        tenantSlug: req.tenantSlug,
        membershipCheckout: row.membership_checkout || null,
        currency_code: row.currency_code || null,
      });
    } catch (err) {
      console.error("tenant membership-checkout GET error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.put(
  "/:slug/membership-checkout",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const payload = req.body?.membershipCheckout;

      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ error: "membershipCheckout object is required." });
      }

      const r = await db.query(
        `
        UPDATE tenants
        SET branding = jsonb_set(
          COALESCE(branding, '{}'::jsonb),
          '{membershipCheckout}',
          $2::jsonb,
          true
        )
        WHERE id = $1
        RETURNING COALESCE(branding, '{}'::jsonb) #> '{membershipCheckout}' AS membership_checkout
        `,
        [tenantId, JSON.stringify(payload)]
      );

      return res.json({ membershipCheckout: r.rows?.[0]?.membership_checkout || null });
    } catch (err) {
      console.error("tenant membership-checkout PUT error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
