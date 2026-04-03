// utils/servicesHelpers.js
// Shared helpers extracted from routes/services.js

const db = require("../db");
const { pool } = require("../db");

async function resolveTenantFromServiceId(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const { rows } = await db.query("SELECT tenant_id FROM services WHERE id = $1", [id]);
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    req.tenantId = Number(rows[0].tenant_id);
    // also set body/query for any downstream helpers
    req.body = req.body || {};
    req.body.tenantId = req.body.tenantId || req.tenantId;
    return next();
  } catch (e) {
    console.error("resolveTenantFromServiceId error:", e);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}
const { assertWithinPlanLimit } = require("../utils/planEnforcement");

// Upload middleware (multer) + error handler
const { upload, uploadErrorHandler } = require("../middleware/upload");
// Cloudflare R2 helper
const { uploadFileToR2, deleteFromR2, safeName } = require("../utils/r2");

const fsp = require("fs/promises");

const ALLOWED_AVAILABILITY_BASIS = new Set(["auto", "resource", "staff", "both", "none"]);
function normalizeAvailabilityBasis(v) {
  if (v == null || v === "") return null;
  const s = String(v).toLowerCase().trim();
  if (!ALLOWED_AVAILABILITY_BASIS.has(s)) return null;
  return s;
}

function normalizeAllowMembership(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "0" || s === "no" || s === "n") return false;
  return undefined;
}

async function getServicesColumns() {
  const { rows } = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services'
    `
  );
  return new Set(rows.map((r) => r.column_name));
}

async function getTenantsColumns() {
  const { rows } = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenants'
    `
  );
  return new Set(rows.map((r) => r.column_name));
}

// Cache whether the service_hours table exists so we don't re-query
// information_schema on every request.
let _serviceHoursTableExists = null;
async function serviceHoursTableExists() {
  if (_serviceHoursTableExists !== null) return _serviceHoursTableExists;
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'service_hours' LIMIT 1`
  );
  _serviceHoursTableExists = rows.length > 0;
  return _serviceHoursTableExists;
}

// ---------------------------------------------------------------------------
// GET /api/services?tenantSlug=&tenantId=&includeInactive=1
// Public (used by booking UI + owner setup UI)
// ---------------------------------------------------------------------------

module.exports = { resolveTenantFromServiceId, normalizeAvailabilityBasis, normalizeAllowMembership, getServicesColumns, getTenantsColumns, serviceHoursTableExists };
