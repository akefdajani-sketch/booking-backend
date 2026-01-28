// routes/tenants.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const { requireTenant } = require("../middleware/requireTenant");

// ✅ IMPORTANT: destructure these (do NOT do: const upload = require(...))
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, deleteFromR2, safeName } = require("../utils/r2");

const fs = require("fs/promises");

// -----------------------------------------------------------------------------
// Onboarding (computed state)
// -----------------------------------------------------------------------------

/**
 * Compute onboarding state for a tenant based on existing data.
 * This is DERIVED state (no manual toggles).
 *
 * v1 rules:
 *  - business: name + timezone present
 *  - hours: at least 1 open day with valid open/close
 *  - services: at least 1 active service
 *  - capacity: at least 1 active staff OR 1 active resource
 *  - first_booking: at least 1 booking with status confirmed|completed
 */
async function computeOnboardingSnapshot(tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) {
    throw new Error("Invalid tenantId");
  }

  const tenantRes = await db.query(
    `SELECT id, slug, name, timezone FROM tenants WHERE id = $1 LIMIT 1`,
    [tid]
  );
  const tenant = tenantRes.rows?.[0];
  if (!tenant) return null;

  const business =
    Boolean(String(tenant.name || "").trim()) &&
    Boolean(String(tenant.timezone || "").trim());

  const hoursRes = await db.query(
    `
    SELECT COUNT(*)::int AS open_days
    FROM tenant_hours
    WHERE tenant_id = $1
      AND COALESCE(is_closed, FALSE) = FALSE
      AND open_time IS NOT NULL
      AND close_time IS NOT NULL
      AND open_time < close_time
    `,
    [tid]
  );
  const openDays = Number(hoursRes.rows?.[0]?.open_days || 0);
  const hours = openDays > 0;

  const servicesRes = await db.query(
    `
    SELECT COUNT(*)::int AS active_services
    FROM services
    WHERE tenant_id = $1
      AND COALESCE(is_active, TRUE) = TRUE
    `,
    [tid]
  );
  const activeServices = Number(servicesRes.rows?.[0]?.active_services || 0);
  const services = activeServices > 0;

  const staffRes = await db.query(
    `
    SELECT COUNT(*)::int AS active_staff
    FROM staff
    WHERE tenant_id = $1
      AND COALESCE(is_active, TRUE) = TRUE
    `,
    [tid]
  );
  const activeStaff = Number(staffRes.rows?.[0]?.active_staff || 0);

  const resourcesRes = await db.query(
    `
    SELECT COUNT(*)::int AS active_resources
    FROM resources
    WHERE tenant_id = $1
      AND COALESCE(is_active, TRUE) = TRUE
    `,
    [tid]
  );
  const activeResources = Number(resourcesRes.rows?.[0]?.active_resources || 0);

  const capacity = activeStaff > 0 || activeResources > 0;

  const bookingsRes = await db.query(
    `
    SELECT COUNT(*)::int AS good_bookings
    FROM bookings
    WHERE tenant_id = $1
      AND status = ANY(ARRAY['confirmed','completed']::text[])
    `,
    [tid]
  );
  const goodBookings = Number(bookingsRes.rows?.[0]?.good_bookings || 0);
  const first_booking = goodBookings > 0;

  const completed = business && hours && services && capacity && first_booking;

  const missing = [];
  if (!business) missing.push("business");
  if (!hours) missing.push("hours");
  if (!services) missing.push("services");
  if (!capacity) missing.push("capacity");
  if (!first_booking) missing.push("first_booking");

  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    steps: {
      business,
      hours,
      services,
      capacity,
      first_booking,
    },
    metrics: {
      openDays,
      activeServices,
      activeStaff,
      activeResources,
      goodBookings,
    },
    missing,
    completed,
    updatedAt: new Date().toISOString(),
  };
}

async function persistOnboardingSnapshot(tenantId, snapshot) {
  await db.query(
    `
    UPDATE tenants
    SET branding = jsonb_set(
      COALESCE(branding, '{}'::jsonb),
      '{onboarding}',
      $2::jsonb,
      true
    )
    WHERE id = $1
    `,
    [Number(tenantId), JSON.stringify(snapshot || {})]
  );
}

// -----------------------------------------------------------------------------
// Branding JSONB helpers (Phase 2)
// -----------------------------------------------------------------------------
async function setBrandingAsset(tenantId, jsonPathArray, value) {
  // jsonPathArray example: ["assets","logoUrl"] or ["assets","banners","book"]
  const result = await db.query(
    `
    UPDATE tenants
    SET branding = jsonb_set(
      COALESCE(branding, '{}'::jsonb),
      $2::text[],
      to_jsonb($3::text),
      true
    )
    WHERE id = $1
    RETURNING id, slug, branding
    `,
    [tenantId, jsonPathArray, String(value || "")]
  );
  return result.rows?.[0] || null;
}

// -----------------------------------------------------------------------------
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
        allow_pending,
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
// POST /api/tenants
// Admin/Owner: create a tenant (minimal fields only; no DB migration required)
// Body:
//   { name, slug, kind?, timezone?, branding? }
// Notes:
//   - slug must be unique
//   - we default branding to {} if not provided
// -----------------------------------------------------------------------------
router.post("/", requireAdmin, async (req, res) => {
  try {
    const rawName = String(req.body?.name || "").trim();
    const rawSlug = String(req.body?.slug || "").trim();

    if (!rawName) return res.status(400).json({ error: "Missing name" });
    if (!rawSlug) return res.status(400).json({ error: "Missing slug" });

    // normalize slug (lowercase, url-safe)
    const slug = rawSlug
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    if (!slug) {
      return res.status(400).json({ error: "Invalid slug" });
    }
    if (slug.length > 80) {
      return res.status(400).json({ error: "Slug too long" });
    }

    const name = rawName.length > 200 ? rawName.slice(0, 200) : rawName;

    const kind = req.body?.kind != null ? String(req.body.kind).trim() : null;
    const timezone = req.body?.timezone != null ? String(req.body.timezone).trim() : null;

    // Optional branding JSON (must be an object)
    let branding = req.body?.branding;
    if (branding == null) branding = {};
    if (typeof branding !== "object" || Array.isArray(branding)) {
      return res.status(400).json({ error: "branding must be a JSON object" });
    }

    // Ensure unique slug before insert (friendlier error)
    const exists = await db.query(`SELECT 1 FROM tenants WHERE slug = $1 LIMIT 1`, [slug]);
    if (exists.rows.length) {
      return res.status(409).json({ error: "Slug already exists" });
    }

    const result = await db.query(
      `
      INSERT INTO tenants (slug, name, kind, timezone, branding)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING
        id,
        slug,
        name,
        kind,
        timezone,
        allow_pending,
        branding,
        logo_url,
        cover_image_url,
        banner_book_url,
        banner_reservations_url,
        banner_account_url,
        banner_home_url,
        theme_key,
        layout_key,
        currency_code,
        created_at
      `,
      [slug, name, kind, timezone, JSON.stringify(branding)]
    );

    return res.status(201).json({ tenant: result.rows[0] });
  } catch (err) {
    // Handle race condition on unique constraint (if any)
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "Slug already exists" });
    }
    console.error("Error creating tenant:", err);
    return res.status(500).json({ error: "Failed to create tenant" });
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
        allow_pending,
        branding,
        logo_url,
        cover_image_url,
        banner_book_url,
        banner_reservations_url,
        banner_account_url,
        banner_home_url,
        theme_key,
        layout_key,
        currency_code,
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
// GET /api/tenants/by-slug/:slug/branding
// Public: returns branding json only
// -----------------------------------------------------------------------------
router.get("/by-slug/:slug/branding", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing slug" });

    const result = await db.query(`SELECT branding FROM tenants WHERE slug = $1 LIMIT 1`, [
      slug,
    ]);

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    return res.json({ branding: result.rows[0].branding || {} });
  } catch (err) {
    console.error("Error loading tenant branding:", err);
    return res.status(500).json({ error: "Failed to load tenant branding" });
  }
});

// -----------------------------------------------------------------------------
// GET /api/tenants/by-slug/:slug/onboarding
// Admin/Owner: returns computed onboarding snapshot for a tenant.
// By default, also persists snapshot into tenants.branding.onboarding.
// Query: persist=true|false
// -----------------------------------------------------------------------------
router.get("/by-slug/:slug/onboarding", requireAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing slug" });

    const t = await db.query(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [slug]);
    const tenantId = t.rows?.[0]?.id;
    if (!tenantId) return res.status(404).json({ error: "Tenant not found" });

    const snapshot = await computeOnboardingSnapshot(tenantId);
    if (!snapshot) return res.status(404).json({ error: "Tenant not found" });

    const persist = String(req.query.persist ?? "true").toLowerCase() !== "false";
    if (persist) {
      await persistOnboardingSnapshot(tenantId, snapshot);
    }

    return res.json({ onboarding: snapshot });
  } catch (err) {
    console.error("Error computing onboarding by slug:", err);
    return res.status(500).json({ error: "Failed to compute onboarding" });
  }
});

// -----------------------------------------------------------------------------
// GET /api/tenants/:id/onboarding
// Admin/Owner: returns computed onboarding snapshot for a tenantId.
// Query: persist=true|false
// -----------------------------------------------------------------------------
router.get("/:id/onboarding", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }

    const snapshot = await computeOnboardingSnapshot(id);
    if (!snapshot) return res.status(404).json({ error: "Tenant not found" });

    const persist = String(req.query.persist ?? "true").toLowerCase() !== "false";
    if (persist) {
      await persistOnboardingSnapshot(id, snapshot);
    }

    return res.json({ onboarding: snapshot });
  } catch (err) {
    console.error("Error computing onboarding by id:", err);
    return res.status(500).json({ error: "Failed to compute onboarding" });
  }
});


// -----------------------------------------------------------------------------
// PATCH /api/tenants/:id/theme-key
// Admin/Owner: set tenant.theme_key (drives booking page layout without ?layout=...)
// Body: { theme_key: "default_v1" }
// -----------------------------------------------------------------------------
router.patch("/:id/theme-key", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid tenant id" });

    const themeKey = String(req.body?.theme_key || "").trim();
    if (!themeKey) return res.status(400).json({ error: "theme_key is required" });

    // Ensure theme exists and is published (or allow default_v1 even if missing).
    if (themeKey !== "default_v1") {
      const th = await db.query(
        "SELECT key FROM platform_themes WHERE key = $1 AND is_published = TRUE LIMIT 1",
        [themeKey]
      );
      if (!th.rows[0]) return res.status(400).json({ error: "Theme is not published or does not exist" });
    }

    const result = await db.query(
      "UPDATE tenants SET theme_key = $2 WHERE id = $1 RETURNING id, slug, theme_key",
      [id, themeKey]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Tenant not found" });

    return res.json({ tenant: result.rows[0] });
  } catch (err) {
    console.error("Error updating tenant theme_key:", err);
    return res.status(500).json({ error: "Failed to update theme" });
  }
});

// -----------------------------------------------------------------------------
// PATCH /api/tenants/:id/branding
// Admin/Owner: merge patch or replace branding
// Body:
//   { patch: { ... } }   -> merges top-level keys into existing branding
//   { branding: { ... } } -> replaces branding
// -----------------------------------------------------------------------------
router.patch("/:id/branding", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid tenant id" });

    const patch = req.body?.patch;
    const branding = req.body?.branding;

    if ((patch && typeof patch !== "object") || Array.isArray(patch)) {
      return res.status(400).json({ error: "patch must be a JSON object" });
    }
    if ((branding && typeof branding !== "object") || Array.isArray(branding)) {
      return res.status(400).json({ error: "branding must be a JSON object" });
    }
    if (!patch && !branding) {
      return res.status(400).json({ error: "Provide either patch or branding" });
    }

    const result = await db.query(
      branding
        ? `UPDATE tenants SET branding = $2::jsonb WHERE id = $1 RETURNING id, slug, branding`
        : `UPDATE tenants SET branding = COALESCE(branding, '{}'::jsonb) || $2::jsonb WHERE id = $1 RETURNING id, slug, branding`,
      [id, JSON.stringify(branding || patch)]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    return res.json({ tenant: result.rows[0] });
  } catch (err) {
    console.error("Error updating tenant branding:", err);
    return res.status(500).json({ error: "Failed to update tenant branding" });
  }
});

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/logo
// Admin: upload tenant logo to R2 and update tenants.logo_url + tenants.logo_key
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

    const allowed = new Set(["book", "reservations", "account", "home"]);
    if (!allowed.has(slot)) {
      return res.status(400).json({
        error: "Invalid slot. Must be one of: book, reservations, account, home",
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

module.exports = router;
