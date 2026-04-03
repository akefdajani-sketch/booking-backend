// utils/staffScheduleHelpers.js
// Shared helpers extracted from routes/tenantStaffSchedule.js

const db = require("../db");
const requireAdmin  = require("../middleware/requireAdmin");
const requireAppAuth = require("../middleware/requireAppAuth");
const ensureUser    = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole }  = require("../middleware/requireTenantRole");

//   POST   /api/tenant/:slug/staff/:staffId/overrides
//   DELETE /api/tenant/:slug/staff/:staffId/overrides/:overrideId
//
// Notes:
// - tenant isolation is enforced via slug -> tenantId resolution
// - permissions: manager+ (owner/manager)
// - API uses minutes since midnight: start_minute/end_minute
// - DB stores weekly schedule in existing table: staff_weekly_schedule (start_time/end_time as TIME)
// - DB stores date overrides in: staff_schedule_overrides (created by PR-S1 migration)



function extractAdminKey(req) {
  const rawAuth = String(req.headers.authorization || "");
  const bearer = rawAuth.toLowerCase().startsWith("bearer ")
    ? rawAuth.slice(7).trim()
    : null;
  const key =
    bearer ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"] || "").trim();
  return key || null;
}

function isAdminRequest(req) {
  const expected = String(process.env.ADMIN_API_KEY || "").trim();
  if (!expected) return false;
  const key = extractAdminKey(req);
  return !!key && key === expected;
}

// Owner dashboard calls these endpoints via proxy-admin (x-api-key).
// Tenant dashboard calls via Google auth.
function staffScheduleAuth(req, res, next) {
  if (isAdminRequest(req)) return requireAdmin(req, res, next);
  return requireAppAuth(req, res, next);
}

function staffScheduleUser(req, res, next) {
  if (isAdminRequest(req)) return next();
  return ensureUser(req, res, next);
}

function staffScheduleRole(req, res, next) {
  if (isAdminRequest(req)) return next();
  return requireTenantRole("manager")(req, res, next);
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

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validateWeekday(w) {
  return Number.isInteger(w) && w >= 0 && w <= 6;
}

function validateMinutes(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || start > 1439) return false;
  if (end < 1 || end > 1440) return false;
  if (end <= start) return false;
  return true;
}

function normalizePgConflict(err) {
  // Exclusion violation (overlap) is 23P01
  if (err && err.code === "23P01") {
    return {
      status: 409,
      body: {
        error: "SCHEDULE_OVERLAP",
        message: "Time block overlaps with an existing block.",
      },
    };
  }
  // Unique violation is 23505
  if (err && err.code === "23505") {
    const table = String(err.table || "");
    const constraint = String(err.constraint || "");

    // Weekly schedule duplicates
    if (table === "staff_weekly_schedule" || constraint.includes("staff_weekly_schedule")) {
      return {
        status: 409,
        body: {
          error: "DUPLICATE_SCHEDULE_BLOCK",
          message: "A time block with the same values already exists.",
        },
      };
    }

    // Overrides duplicates
    if (table === "staff_schedule_overrides" || constraint.includes("staff_schedule_overrides")) {
      return {
        status: 409,
        body: {
          error: "DUPLICATE_OVERRIDE",
          message: "An override with the same values already exists.",
        },
      };
    }

    return {
      status: 409,
      body: {
        error: "DUPLICATE_RECORD",
        message: "A record with the same values already exists.",
      },
    };
  }
  return null;
}

// Auth wrappers: allow either Google (tenant staff) OR ADMIN_API_KEY (owner proxy-admin).
function requireStaffScheduleAuth(req, res, next) {
  if (isAdminRequest(req)) return requireAdmin(req, res, next);
  return requireAppAuth(req, res, next);
}

function maybeEnsureUser(req, res, next) {
  if (isAdminRequest(req)) return next();
  return ensureUser(req, res, next);
}

const requireManagerRole = requireTenantRole("manager");
function maybeRequireManagerRole(req, res, next) {
  if (isAdminRequest(req)) return next();
  return requireManagerRole(req, res, next);
}

async function assertStaffInTenant(tenantId, staffId) {
  const q = await db.query(
    `SELECT id FROM staff WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [staffId, tenantId]
  );
  return !!q.rows?.length;
}

// -----------------------------------------------------------------------------
// GET /api/tenant/:slug/staff/:staffId/schedule
// -----------------------------------------------------------------------------

module.exports = { extractAdminKey, isAdminRequest, staffScheduleAuth, staffScheduleUser, staffScheduleRole, resolveTenantIdFromParam, asInt, validateWeekday, validateMinutes, normalizePgConflict, requireStaffScheduleAuth, maybeEnsureUser, maybeRequireManagerRole, assertStaffInTenant };
