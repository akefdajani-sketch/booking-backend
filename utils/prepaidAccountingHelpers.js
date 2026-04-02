// utils/prepaidAccountingHelpers.js
//
// Shared helpers for routes/tenantPrepaidAccounting/ sub-files.
// Extracted from routes/tenantPrepaidAccounting.js.
//
// Exports: constants, middleware, payload normalizers, and DB helpers.

const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const requireAppAuth = require("../middleware/requireAppAuth");
const ensureUser = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole } = require("../middleware/requireTenantRole");

const PRODUCT_TYPES = new Set(["service_package", "credit_bundle", "time_pass"]);
const ENTITLEMENT_STATUSES = new Set([
  "active",
  "scheduled",
  "expired",
  "consumed",
  "cancelled",
  "archived",
]);
const ENTITLEMENT_SOURCES = new Set([
  "manual_grant",
  "purchase",
  "migration",
  "admin_adjustment",
  "system",
]);
const TRANSACTION_TYPES = new Set([
  "grant",
  "purchase",
  "adjustment",
  "renewal",
  "expiry",
  "redemption",
  "consumption_reversal",
  "manual_correction",
]);
const REDEMPTION_MODES = new Set(["session", "credit", "minute", "package_use", "manual"]);
const VALIDITY_UNITS = new Set(["none", "days", "weeks", "months"]);

function resolveIncludedQuantityFromProductRow(product) {
  const minutes = Number(product?.minutes_total ?? 0) || 0;
  const credit = Number(product?.credit_amount ?? 0) || 0;
  const sessions = Number(product?.session_count ?? 0) || 0;
  if (minutes > 0) return minutes;
  if (credit > 0) return credit;
  if (sessions > 0) return sessions;
  const rulesQty = Number(product?.rules?.included_quantity ?? product?.rules?.includedQuantity ?? 0) || 0;
  return rulesQty > 0 ? rulesQty : 1;
}

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
    if (!slug) return res.status(400).json({ error: "Missing tenant slug" });

    const tenantId = await getTenantIdFromSlug(slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found" });

    req.tenantId = Number(tenantId);
    req.tenantSlug = slug;
    return next();
  } catch (err) {
    if (err?.code === "TENANT_NOT_FOUND") {
      return res.status(404).json({ error: "Tenant not found" });
    }
    console.error("resolveTenantIdFromParam error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

let prepaidTablesReadyCache = null;
async function ensurePrepaidTablesExist() {
  if (prepaidTablesReadyCache === true) return true;

  const r = await db.query(
    `
    SELECT
      to_regclass('public.prepaid_products') AS prepaid_products,
      to_regclass('public.customer_prepaid_entitlements') AS customer_prepaid_entitlements,
      to_regclass('public.prepaid_transactions') AS prepaid_transactions,
      to_regclass('public.prepaid_redemptions') AS prepaid_redemptions
    `
  );

  const row = r.rows?.[0] || {};
  const ok =
    !!row.prepaid_products &&
    !!row.customer_prepaid_entitlements &&
    !!row.prepaid_transactions &&
    !!row.prepaid_redemptions;

  prepaidTablesReadyCache = ok;
  return ok;
}

async function requirePrepaidTables(req, res, next) {
  try {
    const ok = await ensurePrepaidTablesExist();
    if (!ok) {
      return res.status(503).json({
        error: "Prepaid accounting schema is not installed.",
        code: "PREPAID_SCHEMA_MISSING",
      });
    }
    return next();
  } catch (err) {
    console.error("requirePrepaidTables error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

function asText(value, fallback = "") {
  if (value == null) return fallback;
  return String(value).trim();
}

function asNullableText(value) {
  const v = asText(value, "");
  return v ? v : null;
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function asMoney(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Number(n.toFixed(2));
}

function asBool(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeProductPayload(input) {
  const product = input && typeof input === "object" ? input : {};
  const productType = PRODUCT_TYPES.has(product.productType) ? product.productType : "service_package";
  const validityUnit = VALIDITY_UNITS.has(product.validityUnit) ? product.validityUnit : "days";

  return {
    name: asText(product.name),
    productType,
    description: asText(product.description),
    isActive: product.isActive !== false,
    price: asMoney(product.price, 0),
    currency: asNullableText(product.currency),
    validityUnit,
    validityValue: Math.max(0, asInt(product.validityValue, 0)),
    creditAmount: product.creditAmount == null ? null : Math.max(0, asInt(product.creditAmount, 0)),
    sessionCount: product.sessionCount == null ? null : Math.max(0, asInt(product.sessionCount, 0)),
    minutesTotal: product.minutesTotal == null ? null : Math.max(0, asInt(product.minutesTotal, 0)),
    eligibleServiceIds: Array.isArray(product.eligibleServiceIds)
      ? product.eligibleServiceIds.map((x) => asInt(x, 0)).filter((x) => x > 0)
      : [],
    rules: asJsonObject(product.rules),
  };
}

function normalizeGrantPayload(input) {
  const payload = input && typeof input === "object" ? input : {};
  const source = ENTITLEMENT_SOURCES.has(payload.source) ? payload.source : "manual_grant";
  const status = ENTITLEMENT_STATUSES.has(payload.status) ? payload.status : "active";
  return {
    customerId: asInt(payload.customerId, 0),
    prepaidProductId: asInt(payload.prepaidProductId, 0),
    quantity: Math.max(0, asInt(payload.quantity, 0)),
    startsAt: normalizeTimestamp(payload.startsAt),
    expiresAt: normalizeTimestamp(payload.expiresAt),
    notes: asText(payload.notes),
    metadata: asJsonObject(payload.metadata),
    source,
    status,
  };
}

function normalizeAdjustmentPayload(input) {
  const payload = input && typeof input === "object" ? input : {};
  return {
    quantityDelta: asInt(payload.quantityDelta, 0),
    moneyAmount: payload.moneyAmount == null ? null : asMoney(payload.moneyAmount, 0),
    currency: asNullableText(payload.currency),
    notes: asText(payload.notes),
    metadata: asJsonObject(payload.metadata),
  };
}

function normalizeRedemptionPayload(input) {
  const payload = input && typeof input === "object" ? input : {};
  const redemptionMode = REDEMPTION_MODES.has(payload.redemptionMode)
    ? payload.redemptionMode
    : "manual";
  return {
    customerId: asInt(payload.customerId, 0),
    entitlementId: asInt(payload.entitlementId, 0),
    bookingId: payload.bookingId == null ? null : asInt(payload.bookingId, 0),
    redeemedQuantity: Math.max(0, asInt(payload.redeemedQuantity, 0)),
    redemptionMode,
    notes: asText(payload.notes),
    metadata: asJsonObject(payload.metadata),
  };
}

function actorUserId(req) {
  const id = Number(req.user?.id || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function fetchTenantCurrency(tenantId) {
  const r = await db.query(`SELECT currency_code FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
  return r.rows?.[0]?.currency_code || null;
}


module.exports = { resolveIncludedQuantityFromProductRow, isAdminRequest, requireTenantMeAuth, maybeEnsureUser, resolveTenantIdFromParam, ensurePrepaidTablesExist, requirePrepaidTables, asText, asNullableText, asInt, asMoney, asBool, asJsonObject, normalizeTimestamp, normalizeProductPayload, normalizeGrantPayload, normalizeAdjustmentPayload, normalizeRedemptionPayload, actorUserId, fetchTenantCurrency, requireGoogleAuth, requireAppAuth, requireAdmin, ensureUser, PRODUCT_TYPES, ENTITLEMENT_STATUSES, ENTITLEMENT_SOURCES, TRANSACTION_TYPES, REDEMPTION_MODES, VALIDITY_UNITS, prepaidTablesReadyCache };
