// routes/tenants/publish.js
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
// Publish protocol (Phase 4)
// -----------------------------------------------------------------------------
// This introduces a *last-known-good* snapshot that the public booking UI can
// safely rely on, even if the tenant edits (or deletes) critical data in the
// owner dashboard.
//
// Columns (added in Step 4A):
//  - tenants.branding_published (jsonb)
//  - tenants.publish_status (text)
//  - tenants.publish_errors (jsonb)
//  - tenants.published_at (timestamptz)
//  - tenants.last_validated_at (timestamptz)
//
// Endpoints:
//  - GET  /api/tenants/publish-status?tenantSlug=...
//  - POST /api/tenants/publish?tenantSlug=...
//
// Admin-only (owner dashboard).

// GET /api/tenants/publish-status?tenantSlug=...
router.get("/publish-status", requireAdmin, requireTenant, async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    const validation = await validateTenantPublish(db, tenantId);

    // Snapshots needed by owner UI (Draft vs Live + unpublished diff)
    // Use a schema-safe SELECT list so the dashboard never hard-crashes on a missing column.
    const cols = await getTenantColumnSet();

    // Load current persisted publish metadata (no mutation in GET)
    const meta = await db.query(
      `
      SELECT publish_status, publish_errors, published_at, last_validated_at
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [tenantId]
    );
    const row = meta.rows?.[0] || {};

    const snap = await db.query(
      `
      SELECT
        COALESCE(branding, '{}'::jsonb) AS branding,
        ${cols.has("branding_published") ? "COALESCE(branding_published, '{}'::jsonb)" : "'{}'::jsonb"} AS branding_published
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [tenantId]
    );
    const snapRow = snap.rows?.[0] || {};

    const persistedStatus = String(row.publish_status || "draft");

    // Computed status is derived from *current* DB state.
    // We do not overwrite persisted status here to avoid surprise writes.
    const computedStatus = validation.ok
      ? (persistedStatus === "published" ? "published" : "publishable")
      : (persistedStatus === "published" ? "degraded" : "blocked");

    return res.json({
      tenant: validation.tenant || { id: tenantId },
      persisted: {
        publish_status: persistedStatus,
        publish_errors: row.publish_errors || [],
        published_at: row.published_at || null,
        last_validated_at: row.last_validated_at || null,
      },
      snapshots: {
        branding: snapRow.branding || {},
        branding_published: snapRow.branding_published || {},
      },
      computed: {
        publish_status: computedStatus,
        ok: Boolean(validation.ok),
        errors: validation.errors || [],
        warnings: validation.warnings || [],
        checks: validation.checks || {},
        metrics: validation.metrics || {},
      },
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("GET publish-status error", err);
    return res.status(500).json({ error: "Failed to compute publish status." });
  }
});

// POST /api/tenants/publish?tenantSlug=...
// Body: optional { dryRun?: boolean }
router.post("/publish", maybeEnsureUser, requireTenant, requireAdminOrTenantRole("staff"), requireTenant, async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    const dryRun = Boolean(req.body?.dryRun);

    // -----------------------------------------------------------------------
    // Publish guard (Phase 2D mini-win)
    // If the tenant is already "published" and branding draft equals the
    // published snapshot, return a no-op response.
    //
    // Why:
    // - Prevent accidental "republish" clicks from touching timestamps.
    // - Make UI behavior deterministic (can show "No changes" toast).
    // -----------------------------------------------------------------------
    const guard = await db.query(
      `SELECT publish_status,
              (COALESCE(branding, '{}'::jsonb) = COALESCE(branding_published, '{}'::jsonb)) AS no_branding_changes
         FROM tenants
        WHERE id = $1`,
      [tenantId]
    );

    if (guard.rows?.[0]) {
      const persistedStatus = guard.rows[0].publish_status || "draft";
      const noBrandingChanges = Boolean(guard.rows[0].no_branding_changes);

      // Only treat as "no changes" if the tenant is already published.
      // If they are still draft, pressing publish should still flip state.
      if (persistedStatus === "published" && noBrandingChanges) {
        let appearance_snapshot = null;
        try {
          appearance_snapshot = await writeTenantAppearanceSnapshot(tenantId);
        } catch (e) {
          console.error("publish snapshot refresh error (no_changes path):", e);
        }

        return res.status(200).json({
          ok: true,
          no_changes: true,
          publish_status: "published",
          dryRun,
          serverTime: new Date().toISOString(),
          appearance_snapshot,
        });
      }
    }

    const validation = await validateTenantPublish(db, tenantId);
    const now = new Date().toISOString();

    if (!validation.ok) {
      // Persist blocked state + errors so dashboard can display consistently.
      if (!dryRun) {
        await db.query(
          `
          UPDATE tenants
          SET publish_status = 'blocked',
              publish_errors = $2::jsonb,
              last_validated_at = NOW()
          WHERE id = $1
          `,
          [tenantId, JSON.stringify(validation.errors || [])]
        );
      }

      return res.status(409).json({
        ok: false,
        publish_status: "blocked",
        errors: validation.errors || [],
        warnings: validation.warnings || [],
        checks: validation.checks || {},
        metrics: validation.metrics || {},
        dryRun,
        serverTime: now,
      });
    }

    if (!dryRun) {
      // Copy working branding -> published snapshot.
      const upd = await db.query(
        `
        UPDATE tenants
        SET branding_published = COALESCE(branding, '{}'::jsonb),
            publish_status = 'published',
            publish_errors = '[]'::jsonb,
            published_at = NOW(),
            last_validated_at = NOW()
        WHERE id = $1
        RETURNING publish_status, published_at, last_validated_at
        `,
        [tenantId]
      );

      let appearance_snapshot = null;
      try {
        appearance_snapshot = await writeTenantAppearanceSnapshot(tenantId);
      } catch (e) {
        console.error("publish snapshot refresh error:", e);
      }

      const row = upd.rows?.[0] || {};
      return res.json({
        ok: true,
        publish_status: row.publish_status || "published",
        published_at: row.published_at || null,
        last_validated_at: row.last_validated_at || null,
        warnings: validation.warnings || [],
        checks: validation.checks || {},
        metrics: validation.metrics || {},
        dryRun,
        serverTime: now,
        appearance_snapshot,
      });
    }

    // Dry-run success response
    return res.json({
      ok: true,
      publish_status: "publishable",
      warnings: validation.warnings || [],
      checks: validation.checks || {},
      metrics: validation.metrics || {},
      dryRun,
      serverTime: now,
    });
  } catch (err) {
    console.error("POST publish error", err);
    return res.status(500).json({ error: "Failed to publish tenant." });
  }
});

// -----------------------------------------------------------------------------

};
