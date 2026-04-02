// mePrepaid.js
// Customer self-service prepaid routes: GET /me/prepaid-entitlements, GET /me/prepaid-summary
// Mounted by routes/customers.js

const express = require("express");
const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { getExistingColumns, firstExisting, pickCol, softDeleteClause, safeIntExpr, getErrorCode } = require("../../utils/customerQueryHelpers");


module.exports = function mount(router) {
router.get("/me/prepaid-entitlements", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.json({ entitlements: [] });

    const customerId = cust.rows[0].id;
    const schemaCheck = await pool.query(
      `SELECT
         to_regclass('public.customer_prepaid_entitlements') AS ent,
         to_regclass('public.prepaid_products') AS prod`
    );
    const ready = !!schemaCheck.rows?.[0]?.ent && !!schemaCheck.rows?.[0]?.prod;
    if (!ready) return res.json({ entitlements: [] });

    const q = await pool.query(
      `SELECT
         e.id,
         e.prepaid_product_id,
         e.status,
         e.original_quantity,
         e.remaining_quantity,
         e.starts_at,
         e.expires_at,
         e.notes,
         p.name AS prepaid_product_name,
         p.product_type,
         p.eligible_service_ids,
         p.rules AS product_rules,
         p.credit_amount,
         p.session_count,
         p.minutes_total,
         CASE
           WHEN COALESCE(p.minutes_total, 0) > 0 THEN 'minute'
           WHEN COALESCE(p.credit_amount, 0) > 0 THEN 'credit'
           ELSE 'package_use'
         END AS redemption_mode_hint
       FROM customer_prepaid_entitlements e
       JOIN prepaid_products p
         ON p.id = e.prepaid_product_id
        AND p.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1
         AND e.customer_id = $2
         AND COALESCE(e.status, 'active') = 'active'
         AND COALESCE(e.remaining_quantity, 0) > 0
         AND (e.expires_at IS NULL OR e.expires_at > NOW())
         AND COALESCE(p.is_active, true) = true
       ORDER BY e.updated_at DESC, e.id DESC`,
      [tenantId, customerId]
    );

    return res.json({ entitlements: q.rows });
  } catch (e) {
    console.error("GET /customers/me/prepaid-entitlements error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});
router.get("/me/prepaid-summary", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.json({ summary: { active_entitlements: 0, remaining_quantity: 0 } });

    const customerId = cust.rows[0].id;
    const schemaCheck = await pool.query(
      `SELECT to_regclass('public.customer_prepaid_entitlements') AS ent`
    );
    if (!schemaCheck.rows?.[0]?.ent) {
      return res.json({ summary: { active_entitlements: 0, remaining_quantity: 0 } });
    }

    const q = await pool.query(
      `SELECT
         COUNT(*)::int AS active_entitlements,
         COALESCE(SUM(remaining_quantity), 0)::int AS remaining_quantity
       FROM customer_prepaid_entitlements
       WHERE tenant_id = $1
         AND customer_id = $2
         AND COALESCE(status, 'active') = 'active'
         AND COALESCE(remaining_quantity, 0) > 0
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [tenantId, customerId]
    );
    return res.json({ summary: q.rows?.[0] || { active_entitlements: 0, remaining_quantity: 0 } });
  } catch (e) {
    console.error("GET /customers/me/prepaid-summary error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get my booking history for a tenant
};
