// routes/tenants/media.js
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
// field name must be: "file"
// -----------------------------------------------------------------------------
router.post(
  "/:id/logo",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    let filePath = null;

    try {
      const id = Number(req.params.id);

      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid tenant id" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;

      // Fetch old key (so we can delete on replace)
      const old = await db.query(`SELECT logo_key FROM tenants WHERE id = $1 LIMIT 1`, [id]);
      const oldKey = old.rows?.[0]?.logo_key || null;

      const key = `tenants/${id}/branding/logo/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        "UPDATE tenants SET logo_url=$1, logo_key=$2 WHERE id=$3 RETURNING *",
        [url, key, id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      // Delete old object (best-effort)
      if (oldKey && oldKey !== key) {
        await deleteFromR2(oldKey).catch(() => {});
      }

      // also keep branding.assets.logoUrl in sync
      await setBrandingAsset(id, ["assets", "logoUrl"], result.rows[0].logo_url);
      return res.json(result.rows[0]);
    } catch (err) {
      console.error("Tenant logo upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      if (filePath) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }
);



// -----------------------------------------------------------------------------
// DELETE /api/tenants/:id/logo
// Admin: remove tenant logo (db + branding json) and delete R2 object (best-effort)
// -----------------------------------------------------------------------------
router.delete("/:id/logo", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }

    const old = await db.query(
      "SELECT logo_key FROM tenants WHERE id=$1 LIMIT 1",
      [id]
    );
    const oldKey = old.rows?.[0]?.logo_key || null;

    const result = await db.query(
      "UPDATE tenants SET logo_url=NULL, logo_key=NULL WHERE id=$1 RETURNING *",
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    // Delete from R2 (best-effort)
    if (oldKey) {
      await deleteFromR2(oldKey).catch(() => {});
    }

    // keep branding.assets.logoUrl in sync
    await setBrandingAsset(id, ["assets", "logoUrl"], null);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Tenant logo delete error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/logo-dark  &  POST /api/tenants/:id/logo-light
// Admin: upload dark/light logo variants to R2, stored in branding.assets only
// (no separate DB column — lives purely in the branding JSON draft)
// field name must be: "file"
// -----------------------------------------------------------------------------
for (const variant of ["dark", "light"]) {
  router.post(
    `/:id/logo-${variant}`,
    requireAdmin,
    upload.single("file"),
    uploadErrorHandler,
    async (req, res) => {
      let filePath = null;
      try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
          return res.status(400).json({ error: "Invalid tenant id" });
        }
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }
        filePath = req.file.path;

        const key = `tenants/${id}/branding/logo-${variant}/${Date.now()}-${safeName(req.file.originalname)}`;
        const { url } = await uploadFileToR2({
          filePath,
          contentType: req.file.mimetype,
          key,
        });

        // Store in branding.assets.logoDarkUrl / logoLightUrl
        const brandingKey = variant === "dark" ? ["assets", "logoDarkUrl"] : ["assets", "logoLightUrl"];
        await setBrandingAsset(id, brandingKey, url);

        return res.json({ ok: true, url, [`logo_${variant}_url`]: url });
      } catch (err) {
        console.error(`Tenant logo-${variant} upload error:`, err);
        return res.status(500).json({ error: "Upload failed" });
      } finally {
        if (filePath) await fs.unlink(filePath).catch(() => {});
      }
    }
  );
}

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/favicon
// Admin: upload tenant favicon to R2 and store in tenants.branding.assets.faviconUrl
// field name must be: "file"
// -----------------------------------------------------------------------------
router.post(
  "/:id/favicon",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    let filePath = null;
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid tenant id" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;

      const key = `tenants/${id}/branding/favicon/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        key,
        filePath,
        contentType: req.file.mimetype,
      });

      const tenant = await setBrandingAsset(id, ["assets", "faviconUrl"], url);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });

      return res.json({ tenant, favicon_url: url });
    } catch (err) {
      console.error("Tenant favicon upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      if (filePath) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }
);

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/hero
// Admin: upload tenant hero (default banner) to R2 and store in tenants.branding.assets.heroUrl
// field name must be: "file"
// -----------------------------------------------------------------------------
router.post(
  "/:id/hero",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    let filePath = null;
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid tenant id" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;

      const key = `tenants/${id}/branding/hero/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        key,
        filePath,
        contentType: req.file.mimetype,
      });

      const tenant = await setBrandingAsset(id, ["assets", "heroUrl"], url);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });

      return res.json({ tenant, hero_url: url });
    } catch (err) {
      console.error("Tenant hero upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      if (filePath) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }
);

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/banner/:slot
// Admin: upload tenant banner for bottom tabs (book/reservations/account/home)
// Stores tenants.banner_*_url + tenants.banner_*_key
// field name must be: "file"
// -----------------------------------------------------------------------------
router.post(
  "/:id/banner/:slot",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    let filePath = null;

    try {
      const id = Number(req.params.id);
      const slot = String(req.params.slot || "").trim().toLowerCase();

      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid tenant id" });
      }

      const allowed = new Set(["book", "reservations", "account", "home", "memberships"]);
      if (!allowed.has(slot)) {
        return res.status(400).json({
          error:
            "Invalid slot. Must be one of: home, book, reservations, memberships, account",
        });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;

      const urlCol = `banner_${slot}_url`;
      const keyCol = `banner_${slot}_key`;

      // Read old key
      const old = await db.query(`SELECT ${keyCol} FROM tenants WHERE id = $1 LIMIT 1`, [id]);
      const oldKey = old.rows?.[0]?.[keyCol] || null;

      const key = `tenants/${id}/branding/banner-${slot}/${Date.now()}-${safeName(
        req.file.originalname
      )}`;

      const { url } = await uploadFileToR2({
        filePath,
        contentType: req.file.mimetype,
        key,
      });

      const result = await db.query(
        `UPDATE tenants
         SET ${urlCol} = $1, ${keyCol} = $2
         WHERE id = $3
         RETURNING *`,
        [url, key, id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      // Delete old object (best-effort)
      if (oldKey && oldKey !== key) {
        await deleteFromR2(oldKey).catch(() => {});
      }

      // also keep branding.assets.banners.<slot> in sync
      await setBrandingAsset(id, ["assets", "banners", slot], result.rows[0][urlCol]);
      return res.json(result.rows[0]);
    } catch (err) {
      console.error("Tenant banner upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      if (filePath) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
  }
);



// -----------------------------------------------------------------------------
// DELETE /api/tenants/:id/banner/:slot
// Admin: remove a tenant banner for bottom tabs and delete R2 object (best-effort)
// -----------------------------------------------------------------------------
router.delete("/:id/banner/:slot", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const slot = String(req.params.slot || "").trim().toLowerCase();

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }

    const allowed = new Set(["book", "reservations", "account", "home", "memberships"]);
    if (!allowed.has(slot)) {
      return res.status(400).json({
        error:
          "Invalid slot. Must be one of: home, book, reservations, memberships, account",
      });
    }

    const urlCol = `banner_${slot}_url`;
    const keyCol = `banner_${slot}_key`;

    const old = await db.query(
      `SELECT ${keyCol} FROM tenants WHERE id=$1 LIMIT 1`,
      [id]
    );
    const oldKey = old.rows?.[0]?.[keyCol] || null;

    const result = await db.query(
      `UPDATE tenants SET ${urlCol}=NULL, ${keyCol}=NULL WHERE id=$1 RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    if (oldKey) {
      await deleteFromR2(oldKey).catch(() => {});
    }

    // keep branding.assets.banners.<slot> in sync
    await setBrandingAsset(id, ["assets", "banners", slot], null);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Tenant banner delete error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/library
// Upload an image to the tenant's image library (branding.assets.libraryImages).
// Each upload appends { id, key, url } to the array — it does NOT overwrite.
// field name must be: "file"
// -----------------------------------------------------------------------------
router.post(
  "/:id/library",
  requireAdmin,
  upload.single("file"),
  uploadErrorHandler,
  async (req, res) => {
    let filePath = null;
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid tenant id" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;

      const key = `tenants/${id}/branding/library/${Date.now()}-${safeName(req.file.originalname)}`;
      const { url } = await uploadFileToR2({
        filePath,
        contentType: req.file.mimetype,
        key,
      });

      // Fetch current library array and append the new entry
      const row = await db.query(
        `SELECT COALESCE(branding, '{}'::jsonb) #> '{assets,libraryImages}' AS lib FROM tenants WHERE id = $1 LIMIT 1`,
        [id]
      );

      const existing = Array.isArray(row.rows?.[0]?.lib) ? row.rows[0].lib : [];
      const entry = { id: key.split("/").pop(), key, url };
      const updated = [...existing, entry];

      const result = await db.query(
        `UPDATE tenants
         SET branding = jsonb_set(
           COALESCE(branding, '{}'::jsonb),
           '{assets,libraryImages}',
           $2::jsonb,
           true
         )
         WHERE id = $1
         RETURNING id, slug`,
        [id, JSON.stringify(updated)]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      return res.json({ ok: true, url, public_url: url, key });
    } catch (err) {
      console.error("Tenant library upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    } finally {
      if (filePath) await fs.unlink(filePath).catch(() => {});
    }
  }
);


};
