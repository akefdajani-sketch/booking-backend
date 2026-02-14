const express = require("express");
const router = express.Router();

const db = require("../db");

const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const ensureUser = require("../middleware/ensureUser");
const { requireTenantRole } = require("../middleware/requireTenantRole");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { updateTenantThemeKey } = require("../utils/tenantThemeKey");

// Resolve tenantId from :slug safely
async function resolveTenantIdFromParam(req, res, next) {
  try {
    const raw = req.params && req.params.slug;
    const slug = typeof raw === "string" ? raw.trim() : String(raw || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug" });
    const tenantId = await getTenantIdFromSlug(slug);
    req.tenantId = tenantId;
    req.tenantSlug = slug;
    next();
  } catch (err) {
    console.error("resolveTenantIdFromParam error:", err);
    if (err && err.code === "TENANT_NOT_FOUND") {
      return res.status(404).json({ error: "Tenant not found" });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET branding for tenant (auth optional, but we keep it open like other by-slug routes)
router.get("/:slug/branding", resolveTenantIdFromParam, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, slug, branding
       FROM tenants
       WHERE id = $1`,
      [req.tenantId]
    );
    if (!rows.length) return res.status(404).json({ error: "Tenant not found" });
    return res.json(rows[0]);
  } catch (err) {
    console.error("GET tenant branding error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH branding for tenant (tenant owner/manager)
router.patch(
  "/:slug/branding",
  requireGoogleAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const patch = req.body?.patch;
      if (!patch || typeof patch !== "object") {
        return res.status(400).json({ error: "Missing patch object" });
      }

      // Merge patch into existing branding JSONB
      const { rows } = await db.query(
        `UPDATE tenants
         SET branding = COALESCE(branding, '{}'::jsonb) || $1::jsonb
         WHERE id = $2
         RETURNING id, slug, branding`,
        [JSON.stringify(patch), req.tenantId]
      );

      return res.json({ ok: true, tenant: rows[0] });
    } catch (err) {
      console.error("PATCH tenant branding error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PATCH theme-key for tenant (tenant owner)
// Body: { theme_key: "default_v1" }
router.patch(
  "/:slug/theme-key",
  requireGoogleAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole(["owner"]),
  async (req, res) => {
    try {
      const themeKey = String(req.body?.theme_key || "").trim();
      if (!themeKey) return res.status(400).json({ error: "theme_key is required" });

      const tenant = await updateTenantThemeKey(db, req.tenantId, themeKey);
      return res.json({ tenant });
    } catch (err) {
      const status = Number(err?.status) || 500;
      const msg = err?.message || "Failed to update theme";
      if (status >= 500) console.error("PATCH /api/tenant/:slug/theme-key error:", err);
      return res.status(status).json({ error: status >= 500 ? "Failed to update theme" : msg });
    }
  }
);

module.exports = router;
