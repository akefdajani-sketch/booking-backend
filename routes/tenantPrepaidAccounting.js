const express = require("express");
const router = express.Router();

const db = require("../db");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const requireAdmin = require("../middleware/requireAdmin");
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
  return requireGoogleAuth(req, res, next);
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

router.get(
  "/:slug/prepaid-products",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("staff"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const includeInactive = String(req.query.includeInactive || "").toLowerCase() === "true";
      const rows = await db.query(
        `
        SELECT
          id,
          tenant_id,
          name,
          product_type,
          description,
          is_active,
          price,
          currency,
          validity_unit,
          validity_value,
          credit_amount,
          session_count,
          minutes_total,
          eligible_service_ids,
          rules,
          created_at,
          updated_at
        FROM prepaid_products
        WHERE tenant_id = $1
          AND ($2::boolean OR is_active = true)
        ORDER BY is_active DESC, updated_at DESC, id DESC
        `,
        [tenantId, includeInactive]
      );

      return res.json({
        tenantId,
        tenantSlug: req.tenantSlug,
        products: rows.rows,
        currency_code: await fetchTenantCurrency(tenantId),
      });
    } catch (err) {
      console.error("GET prepaid-products error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.post(
  "/:slug/prepaid-products",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("manager"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const payload = normalizeProductPayload(req.body?.product);
      if (!payload.name) {
        return res.status(400).json({ error: "product.name is required" });
      }

      const r = await db.query(
        `
        INSERT INTO prepaid_products (
          tenant_id,
          name,
          product_type,
          description,
          is_active,
          price,
          currency,
          validity_unit,
          validity_value,
          credit_amount,
          session_count,
          minutes_total,
          eligible_service_ids,
          rules
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb
        )
        RETURNING *
        `,
        [
          tenantId,
          payload.name,
          payload.productType,
          payload.description,
          payload.isActive,
          payload.price,
          payload.currency,
          payload.validityUnit,
          payload.validityValue,
          payload.creditAmount,
          payload.sessionCount,
          payload.minutesTotal,
          JSON.stringify(payload.eligibleServiceIds),
          JSON.stringify(payload.rules),
        ]
      );

      return res.status(201).json({ product: r.rows[0] });
    } catch (err) {
      console.error("POST prepaid-products error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.patch(
  "/:slug/prepaid-products/:productId",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("manager"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const productId = asInt(req.params.productId, 0);
      if (productId <= 0) return res.status(400).json({ error: "Invalid product id" });

      const payload = normalizeProductPayload(req.body?.product);
      if (!payload.name) {
        return res.status(400).json({ error: "product.name is required" });
      }

      const r = await db.query(
        `
        UPDATE prepaid_products
        SET
          name = $3,
          product_type = $4,
          description = $5,
          is_active = $6,
          price = $7,
          currency = $8,
          validity_unit = $9,
          validity_value = $10,
          credit_amount = $11,
          session_count = $12,
          minutes_total = $13,
          eligible_service_ids = $14::jsonb,
          rules = $15::jsonb,
          updated_at = NOW()
        WHERE tenant_id = $1
          AND id = $2
        RETURNING *
        `,
        [
          tenantId,
          productId,
          payload.name,
          payload.productType,
          payload.description,
          payload.isActive,
          payload.price,
          payload.currency,
          payload.validityUnit,
          payload.validityValue,
          payload.creditAmount,
          payload.sessionCount,
          payload.minutesTotal,
          JSON.stringify(payload.eligibleServiceIds),
          JSON.stringify(payload.rules),
        ]
      );

      if (!r.rows.length) return res.status(404).json({ error: "Product not found" });
      return res.json({ product: r.rows[0] });
    } catch (err) {
      console.error("PATCH prepaid-products error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.get(
  "/:slug/prepaid-entitlements",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("staff"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const customerId = asInt(req.query.customerId, 0);
      const status = asText(req.query.status).toLowerCase();
      const limit = Math.min(200, Math.max(1, asInt(req.query.limit, 100)));

      const params = [tenantId];
      const where = ["e.tenant_id = $1"];
      if (customerId > 0) {
        params.push(customerId);
        where.push(`e.customer_id = $${params.length}`);
      }
      if (status && ENTITLEMENT_STATUSES.has(status)) {
        params.push(status);
        where.push(`e.status = $${params.length}`);
      }
      params.push(limit);

      const r = await db.query(
        `
        SELECT
          e.*,
          p.name AS prepaid_product_name,
          p.product_type,
          c.name AS customer_name,
          c.email AS customer_email
        FROM customer_prepaid_entitlements e
        JOIN prepaid_products p
          ON p.id = e.prepaid_product_id
         AND p.tenant_id = e.tenant_id
        LEFT JOIN customers c
          ON c.id = e.customer_id
         AND c.tenant_id = e.tenant_id
        WHERE ${where.join(" AND ")}
        ORDER BY e.updated_at DESC, e.id DESC
        LIMIT $${params.length}
        `,
        params
      );

      return res.json({ entitlements: r.rows });
    } catch (err) {
      console.error("GET prepaid-entitlements error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.post(
  "/:slug/prepaid-entitlements/grant",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("manager"),
  async (req, res) => {
    const client = await db.connect();
    try {
      const tenantId = Number(req.tenantId);
      const payload = normalizeGrantPayload(req.body);
      if (payload.customerId <= 0) return res.status(400).json({ error: "customerId is required" });
      if (payload.prepaidProductId <= 0) return res.status(400).json({ error: "prepaidProductId is required" });
      if (payload.quantity <= 0) return res.status(400).json({ error: "quantity must be greater than 0" });

      await client.query("BEGIN");

      const customerCheck = await client.query(
        `SELECT id FROM customers WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, payload.customerId]
      );
      if (!customerCheck.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found" });
      }

      const productCheck = await client.query(
        `SELECT * FROM prepaid_products WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, payload.prepaidProductId]
      );
      if (!productCheck.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Prepaid product not found" });
      }

      const productRow = productCheck.rows[0];
      const unitQuantity = resolveIncludedQuantityFromProductRow(productRow);
      const packageCount = Math.max(1, Number(payload.quantity || 0));
      const effectiveQuantity = Math.max(1, packageCount * unitQuantity);

      const entitlementRes = await client.query(
        `
        INSERT INTO customer_prepaid_entitlements (
          tenant_id,
          customer_id,
          prepaid_product_id,
          status,
          source,
          original_quantity,
          remaining_quantity,
          starts_at,
          expires_at,
          notes,
          metadata,
          created_by_user_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10::jsonb,$11
        )
        RETURNING *
        `,
        [
          tenantId,
          payload.customerId,
          payload.prepaidProductId,
          payload.status,
          payload.source,
          effectiveQuantity,
          payload.startsAt,
          payload.expiresAt,
          payload.notes,
          JSON.stringify({ ...(payload.metadata || {}), packageCount, unitQuantity, effectiveQuantity }),
          actorUserId(req),
        ]
      );

      const entitlement = entitlementRes.rows[0];

      await client.query(
        `
        INSERT INTO prepaid_transactions (
          tenant_id,
          customer_id,
          entitlement_id,
          prepaid_product_id,
          transaction_type,
          quantity_delta,
          money_amount,
          currency,
          notes,
          metadata,
          actor_user_id
        )
        VALUES (
          $1,$2,$3,$4,'grant',$5,NULL,$6,$7,$8::jsonb,$9
        )
        `,
        [
          tenantId,
          payload.customerId,
          entitlement.id,
          payload.prepaidProductId,
          effectiveQuantity,
          productRow.currency || null,
          payload.notes,
          JSON.stringify({ ...(payload.metadata || {}), packageCount, unitQuantity, effectiveQuantity }),
          actorUserId(req),
        ]
      );

      await client.query("COMMIT");
      return res.status(201).json({ entitlement });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("POST prepaid-entitlements/grant error:", err);
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

router.post(
  "/:slug/prepaid-entitlements/:entitlementId/adjust",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("manager"),
  async (req, res) => {
    const client = await db.connect();
    try {
      const tenantId = Number(req.tenantId);
      const entitlementId = asInt(req.params.entitlementId, 0);
      const payload = normalizeAdjustmentPayload(req.body);
      if (entitlementId <= 0) return res.status(400).json({ error: "Invalid entitlement id" });
      if (payload.quantityDelta === 0) {
        return res.status(400).json({ error: "quantityDelta cannot be 0" });
      }

      await client.query("BEGIN");

      const currentRes = await client.query(
        `
        SELECT *
        FROM customer_prepaid_entitlements
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
        FOR UPDATE
        `,
        [tenantId, entitlementId]
      );
      if (!currentRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Entitlement not found" });
      }

      const current = currentRes.rows[0];
      const nextRemaining = Number(current.remaining_quantity || 0) + payload.quantityDelta;
      if (nextRemaining < 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Adjustment would make remaining quantity negative" });
      }

      const nextStatus = nextRemaining === 0 ? "consumed" : current.status;
      const updateRes = await client.query(
        `
        UPDATE customer_prepaid_entitlements
        SET
          remaining_quantity = $3,
          status = $4,
          updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *
        `,
        [tenantId, entitlementId, nextRemaining, nextStatus]
      );

      await client.query(
        `
        INSERT INTO prepaid_transactions (
          tenant_id,
          customer_id,
          entitlement_id,
          prepaid_product_id,
          transaction_type,
          quantity_delta,
          money_amount,
          currency,
          notes,
          metadata,
          actor_user_id
        )
        VALUES (
          $1,$2,$3,$4,'adjustment',$5,$6,$7,$8,$9::jsonb,$10
        )
        `,
        [
          tenantId,
          current.customer_id,
          current.id,
          current.prepaid_product_id,
          payload.quantityDelta,
          payload.moneyAmount,
          payload.currency,
          payload.notes,
          JSON.stringify(payload.metadata),
          actorUserId(req),
        ]
      );

      await client.query("COMMIT");
      return res.json({ entitlement: updateRes.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("POST prepaid-entitlements/:id/adjust error:", err);
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

router.get(
  "/:slug/prepaid-transactions",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("staff"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const customerId = asInt(req.query.customerId, 0);
      const entitlementId = asInt(req.query.entitlementId, 0);
      const limit = Math.min(250, Math.max(1, asInt(req.query.limit, 100)));

      const params = [tenantId];
      const where = ["t.tenant_id = $1"];
      if (customerId > 0) {
        params.push(customerId);
        where.push(`t.customer_id = $${params.length}`);
      }
      if (entitlementId > 0) {
        params.push(entitlementId);
        where.push(`t.entitlement_id = $${params.length}`);
      }
      params.push(limit);

      const r = await db.query(
        `
        SELECT
          t.*,
          p.name AS prepaid_product_name,
          c.name AS customer_name,
          c.email AS customer_email
        FROM prepaid_transactions t
        LEFT JOIN prepaid_products p
          ON p.id = t.prepaid_product_id
         AND p.tenant_id = t.tenant_id
        LEFT JOIN customers c
          ON c.id = t.customer_id
         AND c.tenant_id = t.tenant_id
        WHERE ${where.join(" AND ")}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $${params.length}
        `,
        params
      );

      return res.json({ transactions: r.rows });
    } catch (err) {
      console.error("GET prepaid-transactions error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.get(
  "/:slug/prepaid-redemptions",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("staff"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const customerId = asInt(req.query.customerId, 0);
      const bookingId = asInt(req.query.bookingId, 0);
      const limit = Math.min(250, Math.max(1, asInt(req.query.limit, 100)));

      const params = [tenantId];
      const where = ["r.tenant_id = $1"];
      if (customerId > 0) {
        params.push(customerId);
        where.push(`r.customer_id = $${params.length}`);
      }
      if (bookingId > 0) {
        params.push(bookingId);
        where.push(`r.booking_id = $${params.length}`);
      }
      params.push(limit);

      const q = await db.query(
        `
        SELECT
          r.*,
          p.name AS prepaid_product_name,
          c.name AS customer_name,
          c.email AS customer_email
        FROM prepaid_redemptions r
        LEFT JOIN prepaid_products p
          ON p.id = r.prepaid_product_id
         AND p.tenant_id = r.tenant_id
        LEFT JOIN customers c
          ON c.id = r.customer_id
         AND c.tenant_id = r.tenant_id
        WHERE ${where.join(" AND ")}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${params.length}
        `,
        params
      );

      return res.json({ redemptions: q.rows });
    } catch (err) {
      console.error("GET prepaid-redemptions error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.post(
  "/:slug/prepaid-redemptions",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("manager"),
  async (req, res) => {
    const client = await db.connect();
    try {
      const tenantId = Number(req.tenantId);
      const payload = normalizeRedemptionPayload(req.body);
      if (payload.customerId <= 0) return res.status(400).json({ error: "customerId is required" });
      if (payload.entitlementId <= 0) return res.status(400).json({ error: "entitlementId is required" });
      if (payload.redeemedQuantity <= 0) {
        return res.status(400).json({ error: "redeemedQuantity must be greater than 0" });
      }

      await client.query("BEGIN");

      const entitlementRes = await client.query(
        `
        SELECT *
        FROM customer_prepaid_entitlements
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
        FOR UPDATE
        `,
        [tenantId, payload.entitlementId]
      );
      if (!entitlementRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Entitlement not found" });
      }

      const entitlement = entitlementRes.rows[0];
      if (Number(entitlement.customer_id) !== payload.customerId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Entitlement does not belong to this customer" });
      }
      if (Number(entitlement.remaining_quantity || 0) < payload.redeemedQuantity) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Insufficient prepaid balance" });
      }
      if (payload.bookingId) {
        const bookingCheck = await client.query(
          `SELECT id FROM bookings WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [tenantId, payload.bookingId]
        );
        if (!bookingCheck.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Booking not found" });
        }
      }

      const redemptionRes = await client.query(
        `
        INSERT INTO prepaid_redemptions (
          tenant_id,
          booking_id,
          customer_id,
          entitlement_id,
          prepaid_product_id,
          redeemed_quantity,
          redemption_mode,
          notes,
          metadata
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
        )
        RETURNING *
        `,
        [
          tenantId,
          payload.bookingId,
          payload.customerId,
          entitlement.id,
          entitlement.prepaid_product_id,
          payload.redeemedQuantity,
          payload.redemptionMode,
          payload.notes,
          JSON.stringify(payload.metadata),
        ]
      );

      const nextRemaining = Number(entitlement.remaining_quantity || 0) - payload.redeemedQuantity;
      const nextStatus = nextRemaining === 0 ? "consumed" : entitlement.status;
      await client.query(
        `
        UPDATE customer_prepaid_entitlements
        SET remaining_quantity = $3, status = $4, updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
        `,
        [tenantId, entitlement.id, nextRemaining, nextStatus]
      );

      await client.query(
        `
        INSERT INTO prepaid_transactions (
          tenant_id,
          customer_id,
          entitlement_id,
          prepaid_product_id,
          transaction_type,
          quantity_delta,
          money_amount,
          currency,
          notes,
          metadata,
          actor_user_id
        )
        VALUES (
          $1,$2,$3,$4,'redemption',$5,NULL,NULL,$6,$7::jsonb,$8
        )
        `,
        [
          tenantId,
          payload.customerId,
          entitlement.id,
          entitlement.prepaid_product_id,
          -payload.redeemedQuantity,
          payload.notes,
          JSON.stringify(payload.metadata),
          actorUserId(req),
        ]
      );

      await client.query("COMMIT");
      return res.status(201).json({ redemption: redemptionRes.rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("POST prepaid-redemptions error:", err);
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

router.get(
  "/:slug/prepaid-accounting-summary",
  requireTenantMeAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  requirePrepaidTables,
  requireTenantRole("staff"),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const summary = await db.query(
        `
        SELECT
          COALESCE((SELECT COUNT(*)::int FROM prepaid_products WHERE tenant_id = $1 AND is_active = true), 0) AS active_products,
          COALESCE((SELECT COUNT(*)::int FROM customer_prepaid_entitlements WHERE tenant_id = $1 AND status = 'active'), 0) AS active_entitlements,
          COALESCE((SELECT COUNT(*)::int FROM prepaid_transactions WHERE tenant_id = $1), 0) AS transaction_count,
          COALESCE((SELECT COUNT(*)::int FROM prepaid_redemptions WHERE tenant_id = $1), 0) AS redemption_count
        `,
        [tenantId]
      );

      return res.json({ summary: summary.rows?.[0] || {} });
    } catch (err) {
      console.error("GET prepaid-accounting-summary error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
