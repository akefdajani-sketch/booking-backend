// routes/tenantPrepaidCatalog.js
// Tenant-scoped standalone prepaid catalog (Phase 1)
// Stored at tenants.branding.prepaidCatalog (JSONB)
//
// Tenant endpoints (slug scoped):
//   GET /api/tenant/:slug/prepaid-catalog
//   PUT /api/tenant/:slug/prepaid-catalog

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

function normalizeCatalog(payload) {
  const products = Array.isArray(payload?.products)
    ? payload.products
    : Array.isArray(payload)
      ? payload
      : [];

  return {
    products: products
      .filter((item) => item && typeof item === "object")
      .map((item, index) => ({
        id: String(item.id || `pp_${index + 1}`),
        name: String(item.name || ""),
        type: item.type === "credit_bundle" || item.type === "time_pass" ? item.type : "service_package",
        description: item.description ? String(item.description) : "",
        isActive: item.isActive !== false,
        price: Number(item.price || 0),
        currency: item.currency ? String(item.currency) : null,
        validityDays: Number(item.validityDays || 0),
        creditAmount: item.creditAmount == null ? null : Number(item.creditAmount || 0),
        sessionCount: item.sessionCount == null ? null : Number(item.sessionCount || 0),
        minutesTotal: item.minutesTotal == null ? null : Number(item.minutesTotal || 0),
        eligibleServiceIds: Array.isArray(item.eligibleServiceIds)
          ? item.eligibleServiceIds.map((x) => Number(x)).filter(Boolean)
          : [],
        allowMembershipBundle: !!item.allowMembershipBundle,
        stackable: !!item.stackable,
        createdAt: item.createdAt ? String(item.createdAt) : null,
        updatedAt: item.updatedAt ? String(item.updatedAt) : null,
      })),
  };
}

router.get(
  "/:slug/prepaid-catalog",
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
          COALESCE(branding, '{}'::jsonb) #> '{prepaidCatalog}' AS prepaid_catalog,
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
        prepaidCatalog: normalizeCatalog(row.prepaid_catalog || { products: [] }),
        currency_code: row.currency_code || null,
      });
    } catch (err) {
      console.error("tenant prepaid-catalog GET error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.put(
  "/:slug/prepaid-catalog",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const payload = normalizeCatalog(req.body?.prepaidCatalog);

      const r = await db.query(
        `
        UPDATE tenants
        SET branding = jsonb_set(
          COALESCE(branding, '{}'::jsonb),
          '{prepaidCatalog}',
          $2::jsonb,
          true
        )
        WHERE id = $1
        RETURNING COALESCE(branding, '{}'::jsonb) #> '{prepaidCatalog}' AS prepaid_catalog
        `,
        [tenantId, JSON.stringify(payload)]
      );

      return res.json({ prepaidCatalog: normalizeCatalog(r.rows?.[0]?.prepaid_catalog || payload) });
    } catch (err) {
      console.error("tenant prepaid-catalog PUT error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
