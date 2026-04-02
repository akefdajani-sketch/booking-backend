// routes/adminTenantsTheme/branding.js
// branding save-draft/publish/rollback, banner-focal
// Mounted by routes/adminTenantsTheme.js

const db = require("../../db");
const { pool } = require("../../db");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const {
  isPlainObject, stableStringify, jsonDiff, summarizeDiff, stripComputedVarsFromBranding,
  setTenantIdFromParam, ensureThemeSchemaColumns, ensureBrandingColumns, ensureThemeKeyColumn,
  ensureBrandOverridesColumn, ensureAppearanceSnapshotColumns, refreshAppearanceSnapshot,
  ensureChangelog, logChange, getActor, parseJsonBody,
} = require("../../utils/adminTenantsThemeHelpers");


module.exports = function mount(router) {
router.get("/:tenantId/branding", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();

    const { rows } = await db.query(
      `SELECT id, branding, branding_published, publish_status, branding_draft_saved_at, branding_published_at
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );

    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

    return res.json({
      tenant_id: rows[0].id,
      draft: rows[0].branding || {},
      published: rows[0].branding_published || {},
      publish_status: rows[0].publish_status || null,
      draft_saved_at: rows[0].branding_draft_saved_at || null,
      published_at: rows[0].branding_published_at || null,
    });
  } catch (e) {
    console.error("GET /api/admin/tenants/:tenantId/branding error:", e);
    return res.status(500).json({ error: "Failed to load branding" });
  }
});

router.post("/:tenantId/branding/save-draft", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();

    const brandingRaw = parseJsonBody(req);
    if (!brandingRaw) return res.status(400).json({ error: "Missing draft branding" });

    // Strip glass/pattern/selection vars that the snapshot resolver computes
    // dynamically. Storing them in brand_overrides would permanently override
    // the computed values and make Brand Setup color changes have no effect.
    const branding = stripComputedVarsFromBranding(brandingRaw);

    await db.query(
      `UPDATE tenants
       SET branding = $1::jsonb,
           branding_draft_saved_at = NOW(),
           publish_status = COALESCE(NULLIF(publish_status, ''), 'draft')
       WHERE id = $2`,
      [JSON.stringify(branding), tenantId]
    );

    await logChange(tenantId, "BRANDING_SAVE_DRAFT", getActor(req), { bytes: JSON.stringify(branding).length });

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/admin/tenants/:tenantId/branding/save-draft error:", e);
    return res.status(500).json({ error: "Failed to save branding draft" });
  }
});

router.post("/:tenantId/branding/publish", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();

    // Strip computed vars from the draft before promoting to published.
    // This ensures the published snapshot is always clean even if old saved
    // drafts still contain stale glass/pattern overrides from before this fix.
    const { rows: draftRows } = await db.query(
      `SELECT branding FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const draftBranding = draftRows[0]?.branding ?? {};
    const cleanBranding = stripComputedVarsFromBranding(
      typeof draftBranding === "object" ? draftBranding : {}
    );

    const { rows } = await db.query(
      `UPDATE tenants
       SET branding = $2::jsonb,
           branding_published = $2::jsonb,
           branding_published_at = NOW(),
           publish_status = 'published'
       WHERE id = $1
       RETURNING branding_published_at`,
      [tenantId, JSON.stringify(cleanBranding)]
    );

    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });

    await logChange(tenantId, "BRANDING_PUBLISH", getActor(req), {});
    const appearance_snapshot = await refreshAppearanceSnapshot(tenantId);

    return res.json({ ok: true, published_at: rows[0].branding_published_at, appearance_snapshot });
  } catch (e) {
    console.error("POST /api/admin/tenants/:tenantId/branding/publish error:", e);
    return res.status(500).json({ error: "Failed to publish branding" });
  }
});

router.post("/:tenantId/branding/rollback", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    await ensureBrandingColumns();

    const { rows } = await db.query(
      `UPDATE tenants
       SET branding = branding_published,
           branding_draft_saved_at = NOW()
       WHERE id = $1
       RETURNING branding_published IS NOT NULL AS has_published`,
      [tenantId]
    );

    if (!rows[0]) return res.status(404).json({ error: "Tenant not found" });
    if (!rows[0].has_published) {
      return res.status(400).json({ error: "Nothing published yet" });
    }

    await logChange(tenantId, "BRANDING_ROLLBACK", getActor(req), {});

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/admin/tenants/:tenantId/branding/rollback error:", e);
    return res.status(500).json({ error: "Failed to rollback branding" });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PATCH /api/admin/tenants/:tenantId/banner-focal
// Saves focal point (x/y as percentages 0–100) for a banner slot.
// Stored in branding.image_settings.banner_{slot} so it travels through
// the existing publish / snapshot mechanism at zero extra cost.
//
// Body: { slot: "home"|"book"|"reservations"|"memberships"|"account", focal_x: number, focal_y: number }
// ---------------------------------------------------------------------------
router.patch("/:tenantId/banner-focal", setTenantIdFromParam, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenantId" });
    }

    const VALID_SLOTS = new Set(["home", "book", "reservations", "memberships", "account"]);
    const { slot, focal_x, focal_y } = req.body || {};

    if (!slot || !VALID_SLOTS.has(slot)) {
      return res.status(400).json({ error: "slot must be one of: home, book, reservations, memberships, account" });
    }
    const x = Number(focal_x);
    const y = Number(focal_y);
    if (!Number.isFinite(x) || x < 0 || x > 100 || !Number.isFinite(y) || y < 0 || y > 100) {
      return res.status(400).json({ error: "focal_x and focal_y must be numbers between 0 and 100" });
    }

    await ensureBrandingColumns();

    // Read current branding JSONB so we can merge in the new focal point
    // without clobbering any other branding fields.
    const existing = await db.query(
      `SELECT branding FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const currentBranding = (existing.rows[0]?.branding && typeof existing.rows[0].branding === "object")
      ? existing.rows[0].branding
      : {};

    const updatedBranding = {
      ...currentBranding,
      image_settings: {
        ...(currentBranding.image_settings || {}),
        [`banner_${slot}`]: { focal_x: Math.round(x), focal_y: Math.round(y) },
      },
    };

    await db.query(
      `UPDATE tenants
       SET branding = $1::jsonb,
           branding_draft_saved_at = NOW(),
           publish_status = COALESCE(NULLIF(publish_status, ''), 'draft')
       WHERE id = $2`,
      [JSON.stringify(updatedBranding), tenantId]
    );

    await logChange(tenantId, "BANNER_FOCAL_SAVE", getActor(req), { slot, focal_x: Math.round(x), focal_y: Math.round(y) });

    return res.json({
      ok: true,
      slot,
      focal_x: Math.round(x),
      focal_y: Math.round(y),
    });
  } catch (e) {
    console.error("PATCH /api/admin/tenants/:tenantId/banner-focal error:", e);
    return res.status(500).json({ error: "Failed to save focal point" });
  }
});

// Phase D1: Admin Plan Summary (read-only)
// GET /api/admin/tenants/:tenantId/plan-summary
// - Used by Owner/Tenant setup UI to show plan, limits, usage, and trial state.
// ---------------------------------------------------------------------------
router.get("/:tenantId/plan-summary", setTenantIdFromParam, requireAdminOrTenantRole("manager"), async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }

    const summary = await getPlanSummaryForTenant(tenantId);
    return res.json(summary);
  } catch (e) {
    console.error("GET /api/admin/tenants/:tenantId/plan-summary error:", e);
    return res.status(500).json({ error: "Failed to load plan summary" });
  }
});
};
