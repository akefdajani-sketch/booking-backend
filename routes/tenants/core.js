// routes/tenants/core.js
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
// GET /api/tenants
// Public: returns list of tenants (safe fields only)
// -----------------------------------------------------------------------------
router.get("/", requireAdmin, async (req, res) => {
  try {
    const cols = await getTenantColumnSet();

    const select = [
      "id",
      "slug",
      "name",
      "kind",
      "timezone",
      "allow_pending",
      "branding",
      cols.has("logo_url") ? "logo_url" : "NULL::text AS logo_url",
      cols.has("cover_image_url") ? "cover_image_url" : "NULL::text AS cover_image_url",
      // Banners (canonicalize legacy *_url1 into *_url)
      cols.has("banner_book_url")
        ? "banner_book_url"
        : cols.has("banner_book_url1")
          ? "banner_book_url1 AS banner_book_url"
          : "NULL::text AS banner_book_url",
      cols.has("banner_reservations_url")
        ? "banner_reservations_url"
        : cols.has("banner_reservations_url1")
          ? "banner_reservations_url1 AS banner_reservations_url"
          : "NULL::text AS banner_reservations_url",
      cols.has("banner_account_url")
        ? "banner_account_url"
        : cols.has("banner_account_url1")
          ? "banner_account_url1 AS banner_account_url"
          : "NULL::text AS banner_account_url",
      cols.has("banner_home_url")
        ? "banner_home_url"
        : cols.has("banner_home_url1")
          ? "banner_home_url1 AS banner_home_url"
          : "NULL::text AS banner_home_url",
      cols.has("banner_memberships_url")
        ? "banner_memberships_url"
        : cols.has("banner_memberships_url1")
          ? "banner_memberships_url1 AS banner_memberships_url"
          : "NULL::text AS banner_memberships_url",
      cols.has("theme_key") ? "theme_key" : "NULL::text AS theme_key",
      cols.has("layout_key") ? "layout_key" : "NULL::text AS layout_key",
      cols.has("brand_overrides_json") ? "brand_overrides_json" : "NULL::jsonb AS brand_overrides_json",
      cols.has("currency_code") ? "currency_code" : "NULL::text AS currency_code",
      cols.has("default_phone_country_code") ? "default_phone_country_code" : "NULL::text AS default_phone_country_code",
      cols.has("address_line1") ? "address_line1" : "NULL::text AS address_line1",
      cols.has("address_line2") ? "address_line2" : "NULL::text AS address_line2",
      cols.has("city") ? "city" : "NULL::text AS city",
      cols.has("region") ? "region" : "NULL::text AS region",
      cols.has("postal_code") ? "postal_code" : "NULL::text AS postal_code",
      cols.has("country_code") ? "country_code" : "NULL::text AS country_code",
      cols.has("admin_name") ? "admin_name" : "NULL::text AS admin_name",
      cols.has("admin_email") ? "admin_email" : "NULL::text AS admin_email",
      "created_at",
    ].join(",\n        ");

    const q = `
      SELECT
        ${select}
      FROM tenants
      ORDER BY name ASC
    `;

    const result = await db.query(q);
    return res.json({ tenants: result.rows, schemaCompat: true });
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

    // Keep RETURNING to base columns only so tenant creation is compatible with
    // older DB schemas (pre banner_* / layout_key / currency_code columns).
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

    const cols = await getTenantColumnSet();
    const select = [
      "id",
      "slug",
      "name",
      "kind",
      "timezone",
      "allow_pending",
      "branding",
      cols.has("logo_url") ? "logo_url" : "NULL::text AS logo_url",
      cols.has("cover_image_url") ? "cover_image_url" : "NULL::text AS cover_image_url",
      cols.has("banner_book_url")
        ? "banner_book_url"
        : cols.has("banner_book_url1")
          ? "banner_book_url1 AS banner_book_url"
          : "NULL::text AS banner_book_url",
      cols.has("banner_reservations_url")
        ? "banner_reservations_url"
        : cols.has("banner_reservations_url1")
          ? "banner_reservations_url1 AS banner_reservations_url"
          : "NULL::text AS banner_reservations_url",
      cols.has("banner_account_url")
        ? "banner_account_url"
        : cols.has("banner_account_url1")
          ? "banner_account_url1 AS banner_account_url"
          : "NULL::text AS banner_account_url",
      cols.has("banner_home_url")
        ? "banner_home_url"
        : cols.has("banner_home_url1")
          ? "banner_home_url1 AS banner_home_url"
          : "NULL::text AS banner_home_url",
      cols.has("banner_memberships_url")
        ? "banner_memberships_url"
        : cols.has("banner_memberships_url1")
          ? "banner_memberships_url1 AS banner_memberships_url"
          : "NULL::text AS banner_memberships_url",
      cols.has("theme_key") ? "theme_key" : "NULL::text AS theme_key",
      cols.has("layout_key") ? "layout_key" : "NULL::text AS layout_key",
      cols.has("brand_overrides_json") ? "brand_overrides_json" : "NULL::jsonb AS brand_overrides_json",
      cols.has("currency_code") ? "currency_code" : "NULL::text AS currency_code",
      // General settings (optional columns; schema-compat)
      cols.has("default_phone_country_code")
        ? "default_phone_country_code"
        : "NULL::text AS default_phone_country_code",
      cols.has("address_line1") ? "address_line1" : "NULL::text AS address_line1",
      cols.has("address_line2") ? "address_line2" : "NULL::text AS address_line2",
      cols.has("city") ? "city" : "NULL::text AS city",
      cols.has("region") ? "region" : "NULL::text AS region",
      cols.has("postal_code") ? "postal_code" : "NULL::text AS postal_code",
      cols.has("country_code") ? "country_code" : "NULL::text AS country_code",
      cols.has("admin_name") ? "admin_name" : "NULL::text AS admin_name",
      cols.has("admin_email") ? "admin_email" : "NULL::text AS admin_email",
      "created_at",
    ].join(",\n        ");

    const q = `
      SELECT
        ${select}
      FROM tenants
      WHERE slug = $1
      LIMIT 1
    `;

    const result = await db.query(q, [slug]);

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
// GET /api/tenants/by-slug/:slug/dashboard-summary
// Admin/Owner: dashboard summary for owner/[slug] Dashboard tab
// Auth: requireAdmin (x-api-key)
// -----------------------------------------------------------------------------
router.get("/by-slug/:slug/dashboard-summary", requireAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing slug" });

    const t = await db.query(`SELECT id FROM tenants WHERE slug=$1 LIMIT 1`, [slug]);
    if (!t.rows?.length) return res.status(404).json({ error: "Tenant not found" });
    const tenantId = Number(t.rows[0].id);

    const mode = String(req.query.mode || "day").toLowerCase().trim();
    const dateStr = String(req.query.date || "");

    const payload = await getDashboardSummary({ tenantId, tenantSlug: slug, mode, dateStr });
    return res.json(payload);
  } catch (err) {
    console.error("admin tenant dashboard summary error:", err);
    return res.status(500).json({ error: "Failed to load dashboard summary." });
  }
});



// -----------------------------------------------------------------------------
// GET /api/tenants/:id
// Admin/Owner: returns a single tenant by id (full shape).
// Purpose:
//  - Normalizes list vs detail payloads so UI never 'loses' branding fields.
//  - Allows targeted fetch without loading all tenants.
// -----------------------------------------------------------------------------
router.get("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid tenant id" });
    }

	  const cols = await getTenantColumnSet();
	  const select = [
	    "id",
	    "slug",
	    "name",
	    "kind",
	    "timezone",
	    "allow_pending",
	    "branding",
	    cols.has("logo_url") ? "logo_url" : "NULL::text AS logo_url",
	    cols.has("cover_image_url") ? "cover_image_url" : "NULL::text AS cover_image_url",
	    cols.has("banner_book_url")
	      ? "banner_book_url"
	      : cols.has("banner_book_url1")
	        ? "banner_book_url1 AS banner_book_url"
	        : "NULL::text AS banner_book_url",
	    cols.has("banner_reservations_url")
	      ? "banner_reservations_url"
	      : cols.has("banner_reservations_url1")
	        ? "banner_reservations_url1 AS banner_reservations_url"
	        : "NULL::text AS banner_reservations_url",
	    cols.has("banner_account_url")
	      ? "banner_account_url"
	      : cols.has("banner_account_url1")
	        ? "banner_account_url1 AS banner_account_url"
	        : "NULL::text AS banner_account_url",
	    cols.has("banner_home_url")
	      ? "banner_home_url"
	      : cols.has("banner_home_url1")
	        ? "banner_home_url1 AS banner_home_url"
	        : "NULL::text AS banner_home_url",
	    cols.has("theme_key") ? "theme_key" : "NULL::text AS theme_key",
	    cols.has("layout_key") ? "layout_key" : "NULL::text AS layout_key",
	    cols.has("currency_code") ? "currency_code" : "NULL::text AS currency_code",
	    cols.has("default_phone_country_code") ? "default_phone_country_code" : "NULL::text AS default_phone_country_code",
	    cols.has("address_line1") ? "address_line1" : "NULL::text AS address_line1",
	    cols.has("address_line2") ? "address_line2" : "NULL::text AS address_line2",
	    cols.has("city") ? "city" : "NULL::text AS city",
	    cols.has("region") ? "region" : "NULL::text AS region",
	    cols.has("postal_code") ? "postal_code" : "NULL::text AS postal_code",
	    cols.has("country_code") ? "country_code" : "NULL::text AS country_code",
	    cols.has("admin_name") ? "admin_name" : "NULL::text AS admin_name",
	    cols.has("admin_email") ? "admin_email" : "NULL::text AS admin_email",
	    // Payment gateway fields — needed by GeneralSection to pre-populate the UI
	    cols.has("network_merchant_id") ? "network_merchant_id" : "NULL::text AS network_merchant_id",
	    cols.has("network_gateway_url")  ? "network_gateway_url"  : "NULL::text AS network_gateway_url",
	    cols.has("payment_gateway_active") ? "payment_gateway_active" : "false::boolean AS payment_gateway_active",
	    // booking_code_prefix / seq — shown in the General section
	    cols.has("booking_code_prefix") ? "booking_code_prefix" : "NULL::text AS booking_code_prefix",
	    cols.has("booking_seq") ? "booking_seq" : "0::int AS booking_seq",
	    "created_at",
	  ].join(",\n        ");

	  const q = `
	    SELECT
	      ${select}
	    FROM tenants
	    WHERE id = $1
	    LIMIT 1
	  `;

	  const result = await db.query(q, [id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    return res.json({ tenant: result.rows[0] });
  } catch (err) {
    console.error("Error loading tenant by id:", err);
    return res.status(500).json({ error: "Failed to load tenant" });
  }
});

// -----------------------------------------------------------------------------
// PATCH /api/tenants/:id/general
// Tenant owner (or ADMIN_API_KEY) can update general tenant settings.
// Schema-compat: only updates optional columns if they exist.
// -----------------------------------------------------------------------------
router.patch(
  "/:id/general",
  setTenantIdFromParamForRole,
  requireAdminOrTenantRole("owner"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid tenant id" });
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};

      const currentTenantResult = await db.query(
        `SELECT id, name, slug, kind, timezone FROM tenants WHERE id = $1 LIMIT 1`,
        [id]
      );
      const currentTenant = currentTenantResult.rows?.[0] || null;
      if (!currentTenant) return res.status(404).json({ error: "Tenant not found" });

      // Canonical tenant columns (always exist)
      const name = String(body.name ?? currentTenant.name ?? "").trim();
      const slug = String(body.slug ?? currentTenant.slug ?? "").trim();
      const incomingKind = body.kind != null ? String(body.kind).trim() : "";
      const fallbackKind = String(currentTenant.kind ?? body.type ?? "").trim();
      const kind = incomingKind || fallbackKind;
      const timezone = String(body.timezone ?? currentTenant.timezone ?? "").trim();

      if (!name) return res.status(400).json({ error: "name is required" });
      if (!slug) return res.status(400).json({ error: "slug is required" });
      if (!timezone) return res.status(400).json({ error: "timezone is required" });
      if (!kind) return res.status(400).json({ error: "kind is required" });

      const cols = await getTenantColumnSet();

      // Optional general settings fields
      const optional = {
        default_phone_country_code: String(body.default_phone_country_code ?? "").trim() || null,
        address_line1: String(body.address_line1 ?? "").trim() || null,
        address_line2: String(body.address_line2 ?? "").trim() || null,
        city: String(body.city ?? "").trim() || null,
        region: String(body.region ?? "").trim() || null,
        postal_code: String(body.postal_code ?? "").trim() || null,
        country_code: String(body.country_code ?? "").trim() || null,
        admin_name: String(body.admin_name ?? "").trim() || null,
        admin_email: String(body.admin_email ?? "").trim() || null,
      };

      // RENTAL-1: rental_mode_enabled is a boolean flag on the tenant
      if (body.rental_mode_enabled !== undefined) {
        optional.rental_mode_enabled = !!body.rental_mode_enabled;
      }

      // BOOKING IDENTITY: allow setting booking_code_prefix via general PATCH
      if (body.booking_code_prefix !== undefined) {
        const prefix = String(body.booking_code_prefix || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
        if (prefix) optional.booking_code_prefix = prefix;
      }

      const sets = ["name = $1", "slug = $2", "kind = $3", "timezone = $4"]; // stable order
      const vals = [name, slug, kind, timezone];

      // Append optional columns safely
      const appendOptional = (colName, value) => {
        if (!cols.has(colName)) return;
        vals.push(value);
        sets.push(`${colName} = $${vals.length}`);
      };

      appendOptional("default_phone_country_code", optional.default_phone_country_code);
      appendOptional("address_line1", optional.address_line1);
      appendOptional("address_line2", optional.address_line2);
      appendOptional("city", optional.city);
      appendOptional("region", optional.region);
      appendOptional("postal_code", optional.postal_code);
      appendOptional("country_code", optional.country_code);
      appendOptional("admin_name", optional.admin_name);
      appendOptional("admin_email", optional.admin_email);
      // RENTAL-1
      if (optional.rental_mode_enabled !== undefined) appendOptional("rental_mode_enabled", optional.rental_mode_enabled);
      // BOOKING IDENTITY
      if (optional.booking_code_prefix !== undefined) appendOptional("booking_code_prefix", optional.booking_code_prefix);

      vals.push(id);

      const q = `
        UPDATE tenants
        SET ${sets.join(", ")}
        WHERE id = $${vals.length}
        RETURNING *
      `;

      const r = await db.query(q, vals);
      const t = r.rows?.[0] || null;
      if (!t) return res.status(404).json({ error: "Tenant not found" });
      return res.json({ ok: true, tenant: t });
    } catch (err) {
      console.error("PATCH /api/tenants/:id/general error:", err);
      // Handle common unique violations (slug)
      if (String(err?.code || "") === "23505") {
        return res.status(409).json({ error: "Slug already exists." });
      }
      return res.status(500).json({ error: "Failed to save general settings" });
    }
  }
);

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
// PATCH /api/tenants/:id/payment-gateway
// Owner: update per-tenant MPGS payment gateway credentials.
// Credentials are stored on the tenants table (migration 018).
// network_api_password is AES-256-GCM encrypted via TENANT_CREDS_KEY env var.
// Omitting network_api_password preserves the existing encrypted value.
// -----------------------------------------------------------------------------
router.patch(
  "/:id/payment-gateway",
  setTenantIdFromParamForRole,
  requireAdminOrTenantRole("owner"),
  async (req, res) => {
    try {
      const id   = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid tenant id" });

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const cols = await getTenantColumnSet();

      if (!cols.has("network_merchant_id")) {
        return res.status(503).json({ error: "Payment gateway columns not migrated. Run migration 018." });
      }

      const sets = [];
      const vals = [];
      const add  = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

      if (body.network_merchant_id !== undefined)
        add("network_merchant_id", String(body.network_merchant_id || "").trim() || null);

      if (body.network_gateway_url !== undefined)
        add("network_gateway_url", String(body.network_gateway_url || "").trim() || null);

      if (body.network_api_password && String(body.network_api_password).trim()) {
        const raw    = String(body.network_api_password).trim();
        let stored   = raw;
        const encKey = process.env.TENANT_CREDS_KEY || "";
        if (encKey.length >= 32) {
          try {
            const crypto = require("crypto");
            const key    = Buffer.from(encKey.slice(0, 32));
            const iv     = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
            const enc    = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
            const tag    = cipher.getAuthTag();
            stored = `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
          } catch (encErr) {
            console.error("payment-gateway: encryption error:", encErr?.message);
          }
        }
        add("network_api_password", stored);
      }

      if (body.network_merchant_id !== undefined) {
        add("payment_gateway_active", !!(String(body.network_merchant_id || "").trim()));
      }

      if (!sets.length) return res.status(400).json({ error: "No fields to update" });

      vals.push(id);
      const r = await db.query(
        `UPDATE tenants SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      const t = r.rows?.[0] || null;
      if (!t) return res.status(404).json({ error: "Tenant not found" });

      const safe = { ...t };
      delete safe.network_api_password; // never return encrypted secret
      return res.json({ ok: true, tenant: safe });
    } catch (err) {
      console.error("PATCH /api/tenants/:id/payment-gateway error:", err);
      return res.status(500).json({ error: "Failed to save payment gateway settings" });
    }
  }
);

// -----------------------------------------------------------------------------
// POST /api/tenants/:id/payment-gateway/test
// Owner: test saved MPGS credentials with a live session create call.
// Returns { ok: true } on success, error message on failure.
// -----------------------------------------------------------------------------
router.post(
  "/:id/payment-gateway/test",
  setTenantIdFromParamForRole,
  requireAdminOrTenantRole("owner"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid tenant id" });

      let isTenantMpgsEnabled, getCredentials;
      try {
        ({ isTenantMpgsEnabled } = require("../utils/network"));
        ({ getCredentials }      = require("../utils/networkCredentials"));
      } catch {
        return res.status(503).json({ error: "Payment gateway module unavailable" });
      }

      const enabled = await isTenantMpgsEnabled(id);
      if (!enabled) {
        return res.status(400).json({ ok: false, error: "No credentials found. Save Merchant ID and API Password first." });
      }

      const creds = await getCredentials(id);
      if (!creds?.merchantId || !creds?.apiPassword) {
        return res.status(400).json({ ok: false, error: "Credentials incomplete. Save Merchant ID and API Password." });
      }

      const base    = creds.gatewayUrl || process.env.NETWORK_GATEWAY_URL || "https://ap-gateway.mastercard.com";
      const testUrl = `${base}/api/rest/version/61/merchant/${creds.merchantId}/session`;
      const auth    = "Basic " + Buffer.from(`merchant.${creds.merchantId}:${creds.apiPassword}`).toString("base64");

      const https   = require("https");
      const result  = await new Promise((resolve, reject) => {
        const req2 = https.request(testUrl, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
        }, (r) => {
          let body = "";
          r.on("data", (c) => { body += c; });
          r.on("end", () => resolve({ status: r.statusCode, body }));
        });
        req2.on("error", reject);
        req2.setTimeout(8000, () => { req2.destroy(); reject(new Error("Timed out")); });
        req2.end(JSON.stringify({}));
      });

      if (result.status === 201 || result.status === 200) {
        await db.query("UPDATE tenants SET payment_gateway_active = true WHERE id = $1", [id]);
        return res.json({ ok: true, message: "Connected successfully to Network International gateway." });
      }
      if (result.status === 401) {
        return res.status(400).json({ ok: false, error: "Authentication failed. Check Merchant ID and API Password." });
      }
      return res.status(400).json({ ok: false, error: `Gateway returned status ${result.status}.` });
    } catch (err) {
      console.error("POST /api/tenants/:id/payment-gateway/test error:", err);
      return res.status(500).json({ ok: false, error: err?.message || "Connection test failed" });
    }
  }
);

// -----------------------------------------------------------------------------
// PATCH /api/tenants/:id/theme-key
// Admin/Owner: set tenant.theme_key (drives booking page layout without ?layout=...)
// Body: { theme_key: "default_v1" }
// -----------------------------------------------------------------------------
router.patch("/:id/theme-key", setTenantIdFromParamForRole, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid tenant id" });

    const themeKey = String(req.body?.theme_key || "").trim();
    if (!themeKey) return res.status(400).json({ error: "theme_key is required" });

    const tenant = await updateTenantThemeKey(db, id, themeKey);
    return res.json({ tenant });
  } catch (err) {
    const status = Number(err?.status) || 500;
    const msg = err?.message || "Failed to update theme";
    if (status >= 500) console.error("Error updating tenant theme_key:", err);
    return res.status(status).json({ error: status >= 500 ? "Failed to update theme" : msg });
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

};
