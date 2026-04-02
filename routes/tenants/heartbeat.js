// routes/tenants/heartbeat.js
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
// GET /api/tenants/heartbeat?tenantSlug=...
// Tenant-scoped lightweight endpoint for "nudge" polling.
// Returns a single marker that changes whenever bookings change for this tenant.
// -----------------------------------------------------------------------------
router.get("/heartbeat", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Canonical signal is tenants.last_booking_change_at
    // Fallback to legacy JSONB branding.system.lastBookingChangeAt if column is null.
    const result = await db.query(
      `
      SELECT
        COALESCE(
          last_booking_change_at,
          NULLIF((COALESCE(branding, '{}'::jsonb) #>> '{system,lastBookingChangeAt}'), '')::timestamptz
        ) AS last_booking_change_at
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [Number(tenantId)]
    );

    const lastBookingChangeAt = result.rows?.[0]?.last_booking_change_at || null;

    return res.json({
      tenantId,
      lastBookingChangeAt,
      serverTime: new Date().toISOString(),
      // Debug helpers (safe, no secrets). Useful to detect environment mismatch.
      debug: {
        service: process.env.RENDER_SERVICE_NAME || process.env.SERVICE_NAME || null,
        dbName: (() => {
          try {
            const u = new URL(String(process.env.DATABASE_URL || ""));
            return u.pathname ? u.pathname.replace(/^\//, "") : null;
          } catch {
            return null;
          }
        })(),
      },
    });
  } catch (err) {
    console.error("Error loading tenant heartbeat:", err);
    return res.status(500).json({ error: "Failed to load tenant heartbeat" });
  }
});

// -----------------------------------------------------------------------------
// POST /api/tenants/heartbeat/bump?tenantSlug=...
// Admin-protected manual bump for debugging "always null" issues.
// Updates BOTH the canonical column and the legacy JSONB field.
// -----------------------------------------------------------------------------
router.post("/heartbeat/bump", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    const nowIso = new Date().toISOString();

    const upd = await db.query(
      `
      UPDATE tenants
      SET
        last_booking_change_at = NOW(),
        branding = jsonb_set(
          (CASE WHEN jsonb_typeof(branding) = 'object' THEN branding ELSE '{}'::jsonb END),
          '{system,lastBookingChangeAt}',
          to_jsonb($2::text),
          true
        )
      WHERE id = $1
      RETURNING
        last_booking_change_at,
        (CASE WHEN jsonb_typeof(branding) = 'object' THEN branding ELSE '{}'::jsonb END) #>> '{system,lastBookingChangeAt}' AS legacy_last_booking_change_at
      `,
      [tenantId, nowIso]
    );

    const lastBookingChangeAt = upd.rows?.[0]?.last_booking_change_at || null;

    return res.json({
      ok: true,
      tenantId,
      lastBookingChangeAt,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error bumping tenant heartbeat:", err);
    return res.status(500).json({ error: "Failed to bump tenant heartbeat" });
  }
});

// -----------------------------------------------------------------------------
// GET /api/tenants/heartbeat/bump?tenantSlug=...
// Convenience alias for browsers (address bar == GET). Same behavior as POST.
// -----------------------------------------------------------------------------
router.get("/heartbeat/bump", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    const nowIso = new Date().toISOString();

    const upd = await db.query(
      `
      UPDATE tenants
      SET
        last_booking_change_at = NOW(),
        branding = jsonb_set(
          (CASE WHEN jsonb_typeof(branding) = 'object' THEN branding ELSE '{}'::jsonb END),
          '{system,lastBookingChangeAt}',
          to_jsonb($2::text),
          true
        )
      WHERE id = $1
      RETURNING
        last_booking_change_at,
        (CASE WHEN jsonb_typeof(branding) = 'object' THEN branding ELSE '{}'::jsonb END) #>> '{system,lastBookingChangeAt}' AS legacy_last_booking_change_at
      `,
      [tenantId, nowIso]
    );

    const lastBookingChangeAt = upd.rows?.[0]?.last_booking_change_at || null;

    return res.json({
      ok: true,
      tenantId,
      lastBookingChangeAt,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error bumping tenant heartbeat (GET):", err);
    return res.status(500).json({ error: "Failed to bump tenant heartbeat" });
  }
});

// -----------------------------------------------------------------------------

};
