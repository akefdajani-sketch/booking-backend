// routes/tenants.js
//
// Thin orchestrator — mounts domain sub-files onto the shared router.
// Business logic lives in routes/tenants/ sub-files.
//
// Sub-file layout:
//   core.js       — GET/POST/PATCH tenant CRUD, branding, onboarding, theme-key, dashboard-summary
//   content.js    — prepaid-catalog, membership-checkout, home-landing
//   publish.js    — publish protocol (GET publish-status, POST publish)
//   heartbeat.js  — GET/POST/GET heartbeat
//   media.js      — logo and banner upload/delete
//
// All sub-files receive the shared router and a `shared` object containing
// the helpers that were defined in this file's header section.

// routes/tenants.js
const express = require("express");
const router = express.Router();

function setTenantIdFromParamForRole(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid tenant id' });
  req.tenantId = id;
  return next();
}

const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const { requireTenant } = require("../middleware/requireTenant");
const maybeEnsureUser = require("../middleware/maybeEnsureUser");
const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
const { updateTenantThemeKey } = require("../utils/tenantThemeKey");

// ✅ IMPORTANT: destructure these (do NOT do: const upload = require(...))
const { upload, uploadErrorHandler } = require("../middleware/upload");
const { uploadFileToR2, deleteFromR2, safeName } = require("../utils/r2");
const { validateTenantPublish } = require("../utils/publish");
const { getDashboardSummary } = require("../utils/dashboardSummary");
const { writeTenantAppearanceSnapshot } = require("../theme/resolveTenantAppearanceSnapshot");

const fs = require("fs/promises");

// -----------------------------------------------------------------------------
// Tenant column capability (schema-compat)
// -----------------------------------------------------------------------------
// The platform runs across environments that may not always have the latest
// tenant columns. We must NEVER take down the owner dashboard because a SELECT
// referenced a missing column.
//
// Protocol:
//  - Probe information_schema once (cached) to learn which tenant columns exist.
//  - Build SELECT lists using only existing columns.
//  - If legacy columns exist (e.g. banner_*_url1), alias them to the canonical
//    names so the frontend has a stable contract.

let __tenantColsCache = null;
async function getTenantColumnSet() {
  if (__tenantColsCache) return __tenantColsCache;
  const cols = [
    "logo_url",
    "cover_image_url",
    "banner_book_url",
    "banner_reservations_url",
    "banner_account_url",
    "banner_home_url",
    "banner_memberships_url",
    "banner_book_url1",
    "banner_reservations_url1",
    "banner_account_url1",
    "banner_home_url1",
    "banner_memberships_url1",
    "theme_key",
    "layout_key",
    "currency_code",
    // General settings (optional columns; schema-compat)
    "default_phone_country_code",
    "address_line1",
    "address_line2",
    "city",
    "region",
    "postal_code",
    "country_code",
    "admin_name",
    "admin_email",
  ];
  const r = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tenants'
      AND column_name = ANY($1::text[])
    `,
    [cols]
  );
  const set = new Set(r.rows.map((x) => x.column_name));
  __tenantColsCache = set;
  return set;
}

function tenantSelectExpr(colSet, canonical, legacy) {
  // Return a SELECT expression that is safe for the current schema.
  // If canonical exists, select it.
  // Else if legacy exists, select legacy AS canonical.
  // Else return NULL AS canonical.
  if (colSet.has(canonical)) return canonical;
  if (legacy && colSet.has(legacy)) return `${legacy} AS ${canonical}`;
  return `NULL::text AS ${canonical}`;
}

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
      -- allow same-day and overnight hours (e.g. 10:00 -> 00:00 or 18:00 -> 02:00)
      AND (
        open_time < close_time
        OR close_time = '00:00'::time
        OR open_time > close_time
        OR open_time = close_time
      )
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



function normalizePrepaidCatalog(payload) {
  const products = Array.isArray(payload?.products)
    ? payload.products
    : Array.isArray(payload)
      ? payload
      : [];

  return {
    products: products
      .filter((item) => item && typeof item === "object")
      .map((item, index) => ({
        id: String(item.id || `pp_${index + 1}`),
        name: String(item.name || ""),
        type: item.type === "credit_bundle" || item.type === "time_pass" ? item.type : "service_package",
        description: item.description ? String(item.description) : "",
        isActive: item.isActive !== false,
        price: Number(item.price || 0),
        currency: item.currency ? String(item.currency) : null,
        validityDays: Number(item.validityDays || 0),
        creditAmount: item.creditAmount == null ? null : Number(item.creditAmount || 0),
        sessionCount: item.sessionCount == null ? null : Number(item.sessionCount || 0),
        minutesTotal: item.minutesTotal == null ? null : Number(item.minutesTotal || 0),
        eligibleServiceIds: Array.isArray(item.eligibleServiceIds)
          ? item.eligibleServiceIds.map((x) => Number(x)).filter(Boolean)
          : [],
        allowMembershipBundle: !!item.allowMembershipBundle,
        stackable: !!item.stackable,
        createdAt: item.createdAt ? String(item.createdAt) : null,
        updatedAt: item.updatedAt ? String(item.updatedAt) : null,
      })),
  };
}

// -----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mount sub-files
// ---------------------------------------------------------------------------
const shared = { getTenantColumnSet, tenantSelectExpr, computeOnboardingSnapshot, persistOnboardingSnapshot, setTenantIdFromParamForRole, setBrandingAsset, normalizePrepaidCatalog };

require("./tenants/content")(router, shared);
require("./tenants/publish")(router, shared);
require("./tenants/heartbeat")(router, shared);
require("./tenants/core")(router, shared);
require("./tenants/media")(router, shared);

module.exports = router;
