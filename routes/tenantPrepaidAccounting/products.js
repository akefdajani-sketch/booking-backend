// routes/tenantPrepaidAccounting/products.js
// GET/POST/PATCH /:slug/prepaid-products
// Mounted by routes/tenantPrepaidAccounting.js

const db = require("../../db");
const {
  requireTenantMeAuth, maybeEnsureUser, resolveTenantIdFromParam, requirePrepaidTables, requireTenantRole,
  PRODUCT_TYPES, ENTITLEMENT_STATUSES, ENTITLEMENT_SOURCES, TRANSACTION_TYPES, REDEMPTION_MODES, VALIDITY_UNITS,
  asText, asNullableText, asInt, asMoney, asBool, asJsonObject, normalizeTimestamp,
  normalizeProductPayload, normalizeGrantPayload, normalizeAdjustmentPayload, normalizeRedemptionPayload,
  resolveIncludedQuantityFromProductRow, actorUserId, fetchTenantCurrency,
} = require("../../utils/prepaidAccountingHelpers");


module.exports = function mount(router) {
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
};
