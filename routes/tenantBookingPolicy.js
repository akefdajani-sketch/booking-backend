// routes/tenantBookingPolicy.js
// ---------------------------------------------------------------------------
// Patch 151b-fix — Tenant-scoped booking policy endpoints.
//
// Stored at tenants.branding.booking_policy (JSONB) as a flat map of booleans.
//
// Tenant endpoints (slug scoped):
//   GET /api/tenant/:slug/booking-policy
//   PUT /api/tenant/:slug/booking-policy
//
// Why this file exists alongside the /api/tenants/booking-policy routes in
// routes/tenants/content.js:
//   - The SAME OwnerSetupRouter → GeneralSection → BookingPolicyCard chain
//     is rendered in two setup contexts (owner dashboard vs tenant site).
//   - Owner context uses apiBase "/api/owner/proxy" → plural path with
//     ?tenantSlug= (served by content.js).
//   - Tenant context uses apiBase "/api/proxy" → singular slug path
//     /tenant/:slug/... (served by THIS file).
//   - The home-landing pattern works the same way (routes/tenantHomeLanding.js
//     is the singular-path twin of routes/tenants/content.js's plural
//     /home-landing). This file mirrors that exactly.
//
// Auth:
//   - Google (tenant staff) OR ADMIN_API_KEY (owner proxy-admin)
// Permissions:
//   - GET: viewer+
//   - PUT: owner+ (requires setup_write via role rules)
// ---------------------------------------------------------------------------

const express = require("express");
const router = express.Router();

const db = require("../db");
const requireAppAuth = require("../middleware/requireAppAuth");
const requireAdmin = require("../middleware/requireAdmin");
const ensureUser = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole } = require("../middleware/requireTenantRole");

// Same admin-detection logic used in tenantHomeLanding.js.
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

function requireTenantMeAuth(req, res, next) {
  if (isAdminRequest(req)) return requireAdmin(req, res, next);
  return requireAppAuth(req, res, next);
}

function maybeEnsureUser(req, res, next) {
  if (isAdminRequest(req)) return next();
  return ensureUser(req, res, next);
}

async function resolveTenantIdFromParam(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug." });

    const tenantId = await getTenantIdFromSlug(slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found." });

    req.tenantId = tenantId;
    req.tenantSlug = slug;
    return next();
  } catch (err) {
    console.error("resolveTenantIdFromParam (booking-policy) error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// Normalization — keep in sync with routes/tenants/content.js (plural-path)
// and frontend lib/booking-policy/bookingPolicyConfig.ts.
// ---------------------------------------------------------------------------

const BOOKING_POLICY_KEYS = [
  "enforce_working_hours",
  "require_charge",
  "cross_timezone_bookings",
  "show_customer_timezone",
];

const BOOKING_POLICY_DEFAULTS = {
  enforce_working_hours: true,
  require_charge: false,
  cross_timezone_bookings: false,
  show_customer_timezone: false,
};

function normalizeBookingPolicy(input) {
  const src = input && typeof input === "object" ? input : {};
  const out = { ...BOOKING_POLICY_DEFAULTS };
  for (const k of BOOKING_POLICY_KEYS) {
    if (k in src) out[k] = src[k] === true;
  }
  // Parent/child invariant: show_customer_timezone cannot be true unless
  // cross_timezone_bookings is also true.
  if (!out.cross_timezone_bookings) out.show_customer_timezone = false;
  return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET booking policy (viewer+)
router.get(
  "/:slug/booking-policy",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requireTenantRole("viewer"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);

      const r = await db.query(
        `
        SELECT COALESCE(branding, '{}'::jsonb) #> '{booking_policy}' AS booking_policy
        FROM tenants
        WHERE id = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const row = r.rows[0] || {};
      return res.json({
        tenantId,
        tenantSlug: req.tenantSlug,
        bookingPolicy: normalizeBookingPolicy(row.booking_policy),
      });
    } catch (err) {
      console.error("tenant booking-policy GET error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PUT booking policy (owner+)
router.put(
  "/:slug/booking-policy",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requireTenantRole("owner"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const payload = req.body?.bookingPolicy;

      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ error: "bookingPolicy must be an object." });
      }

      const normalized = normalizeBookingPolicy(payload);

      // Single-level jsonb_set avoids the deep-path gotcha where the
      // intermediate key doesn't yet exist on branding.
      const r = await db.query(
        `
        UPDATE tenants
        SET branding = jsonb_set(
          COALESCE(branding, '{}'::jsonb),
          '{booking_policy}',
          $2::jsonb,
          true
        )
        WHERE id = $1
        RETURNING COALESCE(branding, '{}'::jsonb) #> '{booking_policy}' AS booking_policy
        `,
        [tenantId, JSON.stringify(normalized)]
      );

      const row = r.rows[0] || {};
      return res.json({
        tenantId,
        tenantSlug: req.tenantSlug,
        bookingPolicy: normalizeBookingPolicy(row.booking_policy),
        ok: true,
      });
    } catch (err) {
      console.error("tenant booking-policy PUT error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
