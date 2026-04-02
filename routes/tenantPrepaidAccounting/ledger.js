// routes/tenantPrepaidAccounting/ledger.js
// GET transactions, GET redemptions, POST redemption, GET accounting-summary
// Mounted by routes/tenantPrepaidAccounting.js

const db = require("../../db");
const {
  requireTenantMeAuth, maybeEnsureUser, resolveTenantIdFromParam, requirePrepaidTables,
  asText, asNullableText, asInt, asMoney, asBool, asJsonObject, normalizeTimestamp,
  normalizeProductPayload, normalizeGrantPayload, normalizeAdjustmentPayload,
  normalizeRedemptionPayload, resolveIncludedQuantityFromProductRow, actorUserId,
  fetchTenantCurrency,
  PRODUCT_TYPES, ENTITLEMENT_STATUSES, ENTITLEMENT_SOURCES,
  TRANSACTION_TYPES, REDEMPTION_MODES, VALIDITY_UNITS,
} = require("../../utils/prepaidAccountingHelpers");
const { requireTenantRole } = require("../../middleware/requireTenantRole");


module.exports = function mount(router) {
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
};
