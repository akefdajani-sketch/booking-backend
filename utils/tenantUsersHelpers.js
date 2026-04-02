// utils/tenantUsersHelpers.js
//
// Shared helpers for routes/tenantUsers/ sub-files.
// Extracted from routes/tenantUsers.js.

const crypto = require("crypto");
const db = require("../db");
const requireAdmin  = require("../middleware/requireAdmin");
const requireAppAuth = require("../middleware/requireAppAuth");
const ensureUser    = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { validateTenantPublish } = require("../utils/publish");
const { requireTenantRole, normalizeRole } = require("../middleware/requireTenantRole");

//
// Auth:
//   - requireGoogleAuth + ensureUser
// Permissions:
//   - viewer+ can access /me and /users
//   - owner only can invite/update/remove



const ALLOWED_ROLES = new Set(["owner", "manager", "staff", "viewer"]);

function isAdminRequest(req) {
  const expected = String(process.env.ADMIN_API_KEY || "").trim();
  if (!expected) return false;

  const rawAuth = String(req.headers.authorization || "");
  const bearer = rawAuth.toLowerCase().startsWith("bearer ")
    ? rawAuth.slice(7).trim()
    : "";

  const key =
    String(bearer || "").trim() ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"] || "").trim();

  return !!key && key === expected;
}

// For GET /me only: allow either Google (tenant staff) OR ADMIN_API_KEY (owner proxy-admin).
function requireTenantMeAuth(req, res, next) {
  if (isAdminRequest(req)) return requireAdmin(req, res, next);
  return requireAppAuth(req, res, next);
}

function maybeEnsureUser(req, res, next) {
  if (isAdminRequest(req)) return next();
  return ensureUser(req, res, next);
}

const requireViewerRole = requireTenantRole("viewer");
function maybeRequireViewerRole(req, res, next) {
  if (isAdminRequest(req)) return next();
  return requireViewerRole(req, res, next);
}


let __tenantMeColsCache = null;
async function getTenantMeColumnSet() {
  if (__tenantMeColsCache) return __tenantMeColsCache;
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
    "default_phone_country_code",
    "address_line1",
    "address_line2",
    "city",
    "region",
    "postal_code",
    "country_code",
    "admin_name",
    "admin_email",
    "branding",
    "brand_overrides_json",
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
  __tenantMeColsCache = new Set(r.rows.map((x) => x.column_name));
  return __tenantMeColsCache;
}

function tenantMeSelectExpr(colSet, canonical, legacy) {
  if (colSet.has(canonical)) return canonical;
  if (legacy && colSet.has(legacy)) return `${legacy} AS ${canonical}`;
  if (canonical === "branding" || canonical === "brand_overrides_json") {
    return `NULL::jsonb AS ${canonical}`;
  }
  return `NULL::text AS ${canonical}`;
}

async function getTenantDetail(tenantId, tenantSlug) {
  const cols = await getTenantMeColumnSet();
  const select = [
    "id",
    "slug",
    "name",
    "kind",
    "timezone",
    tenantMeSelectExpr(cols, "branding"),
    tenantMeSelectExpr(cols, "logo_url"),
    tenantMeSelectExpr(cols, "cover_image_url"),
    tenantMeSelectExpr(cols, "banner_book_url", "banner_book_url1"),
    tenantMeSelectExpr(cols, "banner_reservations_url", "banner_reservations_url1"),
    tenantMeSelectExpr(cols, "banner_account_url", "banner_account_url1"),
    tenantMeSelectExpr(cols, "banner_home_url", "banner_home_url1"),
    tenantMeSelectExpr(cols, "banner_memberships_url", "banner_memberships_url1"),
    tenantMeSelectExpr(cols, "theme_key"),
    tenantMeSelectExpr(cols, "layout_key"),
    tenantMeSelectExpr(cols, "brand_overrides_json"),
    tenantMeSelectExpr(cols, "currency_code"),
    tenantMeSelectExpr(cols, "default_phone_country_code"),
    tenantMeSelectExpr(cols, "address_line1"),
    tenantMeSelectExpr(cols, "address_line2"),
    tenantMeSelectExpr(cols, "city"),
    tenantMeSelectExpr(cols, "region"),
    tenantMeSelectExpr(cols, "postal_code"),
    tenantMeSelectExpr(cols, "country_code"),
    tenantMeSelectExpr(cols, "admin_name"),
    tenantMeSelectExpr(cols, "admin_email"),
  ].join(",\n        ");

  const result = await db.query(
    `
      SELECT
        ${select}
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
    [Number(tenantId)]
  );
  const tenant = result.rows?.[0] || null;
  if (!tenant) return null;
  if (!tenant.slug && tenantSlug) tenant.slug = tenantSlug;
  return tenant;
}

async function resolveTenantIdFromParam(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug." });
    const tenantId = await getTenantIdFromSlug(slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found." });
    req.tenantSlug = slug;
    req.tenantId = Number(tenantId);
    return next();
  } catch (err) {
    console.error("resolveTenantIdFromParam error:", err);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function base64Url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function toIso(d) {
  try {
    return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  } catch {
    return null;
  }
}

function computeInviteStatus(invite) {
  if (invite.accepted_at) return "accepted";
  const exp = new Date(invite.expires_at);
  if (Number.isFinite(exp.getTime()) && Date.now() > exp.getTime()) return "expired";
  return "pending";
}

async function countOwners(tenantId) {
  const q = await db.query(
    `SELECT COUNT(*)::int AS c FROM tenant_users WHERE tenant_id = $1 AND role = 'owner'`,
    [tenantId]
  );
  return Number(q.rows?.[0]?.c || 0);
}

// -----------------------------------------------------------------------------
// GET /api/tenant/:slug/me
// Returns the caller's role in the tenant
// -----------------------------------------------------------------------------

module.exports = { isAdminRequest, requireTenantMeAuth, maybeEnsureUser, maybeRequireViewerRole, getTenantMeColumnSet, tenantMeSelectExpr, getTenantDetail, resolveTenantIdFromParam, sha256Hex, base64Url, toIso, computeInviteStatus, countOwners };
