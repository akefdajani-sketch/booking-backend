// routes/tenants/content.js
// Mounted into the main tenants router by routes/tenants.js
// Auto-generated imports for tenants sub-router.
// All helpers + shared imports are inherited from the router passed in.
const { pool } = require("../../db");
const db = pool;
const requireAdmin = require("../../middleware/requireAdmin");
const { requireTenant } = require("../../middleware/requireTenant");
const maybeEnsureUser = require("../../middleware/maybeEnsureUser");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const { updateTenantThemeKey } = require("../../utils/tenantThemeKey");
const { upload, uploadErrorHandler } = require("../../middleware/upload");
const { uploadFileToR2, deleteFromR2, safeName } = require("../../utils/r2");
const { validateTenantPublish } = require("../../utils/publish");
const { getDashboardSummary } = require("../../utils/dashboardSummary");
const { writeTenantAppearanceSnapshot } = require("../../theme/resolveTenantAppearanceSnapshot");
const fs = require("fs/promises");

/**
 * @param {import('express').Router} router  The shared tenants router
 * @param {object} shared  Shared helpers from tenants.js (getTenantColumnSet, tenantSelectExpr, etc.)
 */
module.exports = function mount(router, shared) {
  const { getTenantColumnSet, tenantSelectExpr, computeOnboardingSnapshot, persistOnboardingSnapshot, setTenantIdFromParamForRole, setBrandingAsset, normalizePrepaidCatalog } = shared;
// Standalone prepaid catalog (tenant settings)
// Stored at tenants.branding.prepaidCatalog (JSONB)
// Admin-only (owner dashboard).
// -----------------------------------------------------------------------------
// GET /api/tenants/prepaid-catalog?tenantSlug=...
router.get("/prepaid-catalog", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const r = await db.query(
      `
      SELECT
        COALESCE(branding, '{}'::jsonb) #> '{prepaidCatalog}' AS prepaid_catalog,
        currency_code
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [Number(tenantId)]
    );

    const row = r.rows?.[0] || {};
    return res.json({
      prepaidCatalog: normalizePrepaidCatalog(row.prepaid_catalog || { products: [] }),
      currency_code: row.currency_code || null,
    });
  } catch (err) {
    console.error("GET prepaid-catalog error", err);
    return res.status(500).json({ error: "Failed to load prepaid catalog." });
  }
});

// PUT /api/tenants/prepaid-catalog?tenantSlug=...
router.put("/prepaid-catalog", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const payload = normalizePrepaidCatalog(req.body?.prepaidCatalog);

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
      [Number(tenantId), JSON.stringify(normalized)]
    );

    return res.json({ prepaidCatalog: normalizePrepaidCatalog(r.rows?.[0]?.prepaid_catalog || payload) });
  } catch (err) {
    console.error("PUT prepaid-catalog error", err);
    return res.status(500).json({ error: "Failed to save prepaid catalog." });
  }
});

// -----------------------------------------------------------------------------
// Membership checkout policy (tenant settings)
// Stored at tenants.branding.membershipCheckout (JSONB)
// Admin-only (owner dashboard).
// -----------------------------------------------------------------------------
// GET /api/tenants/membership-checkout?tenantSlug=...
router.get("/membership-checkout", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const r = await db.query(
      `
      SELECT
        COALESCE(branding, '{}'::jsonb) #> '{membershipCheckout}' AS membership_checkout,
        currency_code
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [Number(tenantId)]
    );

    const row = r.rows?.[0] || {};
    return res.json({
      membershipCheckout: row.membership_checkout || null,
      currency_code: row.currency_code || null,
    });
  } catch (err) {
    console.error("GET membership-checkout error", err);
    return res.status(500).json({ error: "Failed to load membership checkout policy." });
  }
});

// PUT /api/tenants/membership-checkout?tenantSlug=...
// Body: { membershipCheckout: { ... } }
router.put("/membership-checkout", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
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
      [Number(tenantId), JSON.stringify(payload)]
    );

    return res.json({ membershipCheckout: r.rows?.[0]?.membership_checkout || null });
  } catch (err) {
    console.error("PUT membership-checkout error", err);
    return res.status(500).json({ error: "Failed to save membership checkout policy." });
  }
});


// -----------------------------------------------------------------------------
// Home landing content (booking Home tab)
// Stored at tenants.branding.homeLanding (JSONB)
// Admin-only (owner dashboard).
// -----------------------------------------------------------------------------
// GET /api/tenants/home-landing?tenantSlug=...
router.get("/home-landing", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const r = await db.query(
      `
      SELECT
        COALESCE(branding, '{}'::jsonb) #> '{homeLanding}' AS home_landing,
        currency_code
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [Number(tenantId)]
    );

    const row = r.rows?.[0] || {};
    return res.json({
      homeLanding: row.home_landing || null,
      currency_code: row.currency_code || null,
    });
  } catch (err) {
    console.error("GET home-landing error", err);
    return res.status(500).json({ error: "Failed to load home landing content." });
  }
});

// PUT /api/tenants/home-landing?tenantSlug=...
// Body: { homeLanding: { ... } }
router.put("/home-landing", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const payload = req.body?.homeLanding;
    const normalized = payload && typeof payload === "object" ? payload : {};

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "homeLanding object is required." });
    }

    const r = await db.query(
      `
      UPDATE tenants
      SET branding = jsonb_set(
        COALESCE(branding, '{}'::jsonb),
        '{homeLanding}',
        $2::jsonb,
        true
      )
      WHERE id = $1
      RETURNING COALESCE(branding, '{}'::jsonb) #> '{homeLanding}' AS home_landing
      `,
      [Number(tenantId), JSON.stringify(payload)]
    );

    return res.json({ homeLanding: r.rows?.[0]?.home_landing || null });
  } catch (err) {
    console.error("PUT home-landing error", err);
    return res.status(500).json({ error: "Failed to save home landing content." });
  }
});

// -----------------------------------------------------------------------------

};
