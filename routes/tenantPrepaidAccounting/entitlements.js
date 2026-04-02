// routes/tenantPrepaidAccounting/entitlements.js
// GET /:slug/prepaid-entitlements, POST grant, POST adjust
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
};
