// routes/tenants.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");

// ✅ IMPORTANT: destructure these (do NOT do: const upload = require(...))
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, deleteFromR2, safeName } = require("../utils/r2");

const fs = require("fs/promises");

// -----------------------------------------------------------------------------
// GET /api/tenants
// Public: returns list of tenants (safe fields only)
// -----------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        id,
        slug,
        name,
        kind,
        timezone,
        logo_url,
        cover_image_url,
        -- banners (may be null)
        banner_book_url,
        banner_reservations_url,
        banner_account_url,
        banner_home_url,
        branding,
        created_at
      FROM tenants
      ORDER BY name ASC
      `
    );

    return res.json({ tenants: result.rows });
  } catch (err) {
    console.error("Error loading tenants:", err);
    return res.status(500).json({ error: "Failed to load tenants" });
  }
});

// -----------------------------------------------------------------------------
// GET /api/tenants/by-slug/:slug
// Public: returns one tenant by slug (scale-friendly for owner/[slug] + booking app)
// -----------------------------------------------------------------------------
router.get("/by-slug/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing slug" });

    const result = await db.query(
      `
      SELECT
        id,
        slug,
        name,
        kind,
        timezone,
        logo_url,
        cover_image_url,
        banner_book_url,
        banner_reservations_url,
        banner_account_url,
        banner_home_url,
        branding,
        created_at
      FROM tenants
      WHERE slug = $1
      LIMIT 1
      `,
      [slug]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    return res.json({ tenant: result.rows[0] });
  } catch (err) {
    console.error("Error loading tenant by slug:", err);
    return res.status(500).json({ error: "Failed to load tenant" });
  }
});

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/logo
// Admin: upload tenant logo to R2 and update tenants.logo_url + tenants.logo_key
// field name must be: "file"
// -----------------------------------------------------------------------------


// -----------------------------------------------------------------------------
// Tenant Branding (JSONB)
// -----------------------------------------------------------------------------

// GET /api/tenants/by-slug/:slug/branding  (public read)
router.get("/by-slug/:slug/branding", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing slug" });

    const result = await db.query(
      `
      SELECT branding
      FROM tenants
      WHERE slug = $1
      LIMIT 1
      `,
      [slug]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    return res.json({ branding: result.rows[0].branding || {} });
  } catch (err) {
    console.error("Error loading tenant branding by slug:", err);
    return res.status(500).json({ error: "Failed to load branding" });
  }
});

// PATCH /api/tenants/:id/branding  (admin/owner)
// Body: { patch: {...} } merges into existing branding JSONB
//    or { branding: {...} } replaces entire object
router.patch("/:id/branding", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const { patch, branding } = req.body || {};

    const currentRes = await db.query(
      `SELECT branding FROM tenants WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!currentRes.rows.length) return res.status(404).json({ error: "Tenant not found" });

    const current = currentRes.rows[0].branding || {};

    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    const deepMerge = (a, b) => {
      const out = { ...(isObj(a) ? a : {}) };
      if (!isObj(b)) return out;
      for (const k of Object.keys(b)) {
        if (isObj(b[k]) && isObj(out[k])) out[k] = deepMerge(out[k], b[k]);
        else out[k] = b[k];
      }
      return out;
    };

    let nextBranding = current;
    if (isObj(branding)) nextBranding = branding;
    else if (isObj(patch)) nextBranding = deepMerge(current, patch);
    else return res.status(400).json({ error: "Provide {patch} or {branding}" });

    const upd = await db.query(
      `
      UPDATE tenants
      SET branding = $2::jsonb
      WHERE id = $1
      RETURNING id, slug, branding
      `,
      [id, JSON.stringify(nextBranding)]
    );

    return res.json({ tenant: upd.rows[0] });
  } catch (err) {
    console.error("Error updating tenant branding:", err);
    return res.status(500).json({ error: "Failed to update branding" });
  }
});

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
      const old = await db.query(
        `SELECT logo_key FROM tenants WHERE id = $1 LIMIT 1`,
        [id]
      );
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

      const allowed = new Set(["book", "reservations", "account", "home"]);
      if (!allowed.has(slot)) {
        return res.status(400).json({
          error: "Invalid slot. Must be one of: book, reservations, account, home",
        });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;

      const urlCol = `banner_${slot}_url`;
      const keyCol = `banner_${slot}_key`;

      // Read old key
      const old = await db.query(
        `SELECT ${keyCol} FROM tenants WHERE id = $1 LIMIT 1`,
        [id]
      );
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

module.exports = router;
