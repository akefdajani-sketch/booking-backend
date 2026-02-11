const express = require("express");
const router = express.Router();

const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const ensureUser = require("../middleware/ensureUser");
const { requireTenantRole } = require("../middleware/requireTenantRole");
const { getTenantIdFromSlug } = require("../utils/tenants");

// Resolve tenantId from :slug safely
async function resolveTenantIdFromParam(req, res, next) {
  try {
    const raw = req.params && req.params.slug;
    const slug = typeof raw === "string" ? raw.trim() : String(raw || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug" });
    const tenantId = await getTenantIdFromSlug(req.pool, slug);
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
    const { rows } = await req.pool.query(
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
      const { rows } = await req.pool.query(
        `UPDATE tenants
         SET branding = COALESCE(branding, '{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
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

module.exports = router;
