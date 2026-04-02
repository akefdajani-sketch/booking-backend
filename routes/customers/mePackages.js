// mePackages.js
// Customer self-service package routes: GET/POST /me/packages
// Mounted by routes/customers.js

const express = require("express");
const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { getExistingColumns, firstExisting, pickCol, softDeleteClause, safeIntExpr, getErrorCode } = require("../../utils/customerQueryHelpers");


module.exports = function mount(router) {
function resolveIncludedQuantityFromProductRow(p) {
  const minutes = Number(p?.minutes_total ?? 0) || 0;
  const credit = Number(p?.credit_amount ?? 0) || 0;
  const sessions = Number(p?.session_count ?? 0) || 0;
  if (minutes > 0) return minutes;
  if (credit > 0) return credit;
  if (sessions > 0) return sessions;
  // Fallback: rules can optionally define quantity
  const ruleQty = Number(p?.rules?.included_quantity ?? p?.rules?.includedQuantity ?? 0) || 0;
  return ruleQty > 0 ? ruleQty : 1;
}

function computeExpiryFromValidity(startsAtIso, validityUnit, validityValue) {
  const unit = String(validityUnit || "").toLowerCase();
  const val = Number(validityValue || 0) || 0;
  if (!startsAtIso) return null;
  if (!unit || unit === "none" || val <= 0) return null;

  const d = new Date(startsAtIso);
  if (Number.isNaN(d.getTime())) return null;

  if (unit === "days") d.setDate(d.getDate() + val);
  else if (unit === "weeks") d.setDate(d.getDate() + val * 7);
  else if (unit === "months") d.setMonth(d.getMonth() + val);
  else return null;

  return d.toISOString();
}

function normalizeEntitlementRow(e) {
  const productType = String(e?.product_type || "service_package");
  const unitType =
    Number(e?.minutes_total ?? 0) > 0
      ? "minute"
      : Number(e?.credit_amount ?? 0) > 0
        ? "credit"
        : "package_use";

  const startsAt = e?.starts_at ? new Date(e.starts_at).toISOString() : null;
  const expiresAt = e?.expires_at ? new Date(e.expires_at).toISOString() : null;

  // Derive status if not provided
  const now = Date.now();
  const remaining = Number(e?.remaining_quantity ?? 0) || 0;
  const isExpired = expiresAt ? new Date(expiresAt).getTime() <= now : false;
  const baseStatus = String(e?.status || "").toLowerCase();

  let status = baseStatus || "active";
  if (status === "active") {
    if (isExpired) status = "expired";
    else if (remaining <= 0) status = "consumed";
  }

  return {
    id: e.id,
    tenant_id: e.tenant_id,
    prepaid_product_id: e.prepaid_product_id,
    name: e.prepaid_product_name || e.name || null,
    description: e.description || null,
    product_type: productType,
    unit_type: unitType,
    original_quantity: Number(e?.original_quantity ?? 0) || 0,
    remaining_quantity: remaining,
    starts_at: startsAt,
    expires_at: expiresAt,
    status,
    eligible_service_ids: Array.isArray(e?.eligible_service_ids) ? e.eligible_service_ids : [],
  };
}

function normalizeLedgerRow(r) {
  const unitType = String(r?.unit_type || "").trim() || "package_use";
  return {
    id: r.id,
    entitlement_id: r.entitlement_id,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    source: String(r?.transaction_type || r?.source || "adjustment"),
    delta_quantity: Number(r?.quantity_delta ?? r?.delta_quantity ?? 0) || 0,
    unit_type: unitType,
    note: r?.notes ?? r?.note ?? null,
    booking_id: r?.booking_id ?? null,
  };
}
router.get("/me/packages", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.json({ active: [], history: [] });

    const customerId = cust.rows[0].id;
    const schemaCheck = await pool.query(
      `SELECT
         to_regclass('public.customer_prepaid_entitlements') AS ent,
         to_regclass('public.prepaid_products') AS prod`
    );
    const ready = !!schemaCheck.rows?.[0]?.ent && !!schemaCheck.rows?.[0]?.prod;
    if (!ready) return res.json({ active: [], history: [] });

    // Include all entitlements (active + historical) for the customer.
    const q = await pool.query(
      `SELECT
         e.id,
         e.tenant_id,
         e.prepaid_product_id,
         e.status,
         e.original_quantity,
         e.remaining_quantity,
         e.starts_at,
         e.expires_at,
         e.notes,
         p.name AS prepaid_product_name,
         p.description,
         p.product_type,
         p.eligible_service_ids,
         p.rules,
         p.credit_amount,
         p.session_count,
         p.minutes_total
       FROM customer_prepaid_entitlements e
       JOIN prepaid_products p
         ON p.id = e.prepaid_product_id
        AND p.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1
         AND e.customer_id = $2
       ORDER BY e.updated_at DESC, e.id DESC`,
      [tenantId, customerId]
    );

    const all = q.rows.map(normalizeEntitlementRow);

    const active = all.filter((e) => e.status === "active");
    const history = all.filter((e) => e.status !== "active");

    return res.json({ active, history });
  } catch (e) {
    console.error("GET /customers/me/packages error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});
router.get("/me/packages/:entitlementId/ledger", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    const entitlementId = Number(req.params.entitlementId);
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });
    if (!entitlementId) return res.status(400).json({ error: "Missing entitlement id" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.json({ items: [] });
    const customerId = cust.rows[0].id;

    const schemaCheck = await pool.query(
      `SELECT
         to_regclass('public.prepaid_transactions') AS tx,
         to_regclass('public.customer_prepaid_entitlements') AS ent`
    );
    const ready = !!schemaCheck.rows?.[0]?.tx && !!schemaCheck.rows?.[0]?.ent;
    if (!ready) return res.json({ items: [] });

    const owns = await pool.query(
      `SELECT id FROM customer_prepaid_entitlements
       WHERE tenant_id=$1 AND id=$2 AND customer_id=$3
       LIMIT 1`,
      [tenantId, entitlementId, customerId]
    );
    if (!owns.rows.length) return res.status(404).json({ error: "Entitlement not found" });

    const q = await pool.query(
      `SELECT
         id,
         entitlement_id,
         NULL::int AS booking_id,
         transaction_type,
         quantity_delta,
         notes,
         created_at,
         CASE
           WHEN quantity_delta IS NULL THEN 'package_use'
           WHEN quantity_delta <> 0 THEN 'package_use'
           ELSE 'package_use'
         END AS unit_type
       FROM prepaid_transactions
       WHERE tenant_id=$1 AND entitlement_id=$2 AND customer_id=$3
       ORDER BY created_at DESC, id DESC`,
      [tenantId, entitlementId, customerId]
    );

    return res.json({ items: q.rows.map(normalizeLedgerRow) });
  } catch (e) {
    console.error("GET /customers/me/packages/:id/ledger error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});
router.post("/me/packages/:prepaidProductId/purchase", requireAppAuth, requireTenant, async (req, res) => {
  const client = await pool.connect();
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    const prepaidProductId = Number(req.params.prepaidProductId);
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });
    if (!prepaidProductId) return res.status(400).json({ error: "Missing product id" });

    const cust = await client.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.status(404).json({ error: "Customer not found" });
    const customerId = cust.rows[0].id;

    const schemaCheck = await client.query(
      `SELECT
         to_regclass('public.prepaid_products') AS prod,
         to_regclass('public.customer_prepaid_entitlements') AS ent,
         to_regclass('public.prepaid_transactions') AS tx`
    );
    const ready = !!schemaCheck.rows?.[0]?.prod && !!schemaCheck.rows?.[0]?.ent && !!schemaCheck.rows?.[0]?.tx;
    if (!ready) return res.status(400).json({ error: "Prepaid is not configured" });

    // Confirm product belongs to tenant and is active.
    const prod = await client.query(
      `SELECT *
       FROM prepaid_products
       WHERE tenant_id=$1 AND id=$2 AND COALESCE(is_active, true)=true
       LIMIT 1`,
      [tenantId, prepaidProductId]
    );
    if (!prod.rows.length) return res.status(404).json({ error: "Prepaid product not found" });
    const product = prod.rows[0];

    const startsAtIso = new Date().toISOString();
    const expiresAtIso = computeExpiryFromValidity(startsAtIso, product.validity_unit, product.validity_value);
    const qty = resolveIncludedQuantityFromProductRow(product);

    await client.query("BEGIN");

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
        metadata
      )
      VALUES ($1,$2,$3,'active','purchase',$4,$4,$5,$6,$7,$8::jsonb)
      RETURNING *
      `,
      [
        tenantId,
        customerId,
        prepaidProductId,
        qty,
        startsAtIso,
        expiresAtIso,
        `Initial grant (${product.name || "Package"})`,
        JSON.stringify({ purchased_via: "customer_portal" }),
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
        metadata
      )
      VALUES ($1,$2,$3,$4,'purchase',$5,$6,$7,$8,$9::jsonb)
      `,
      [
        tenantId,
        customerId,
        entitlement.id,
        prepaidProductId,
        qty,
        product.price ?? null,
        product.currency ?? null,
        `Initial grant (${product.name || "Package"})`,
        JSON.stringify({ source: "purchase" }),
      ]
    );

    await client.query("COMMIT");

    // Return normalized entitlement (with product join)
    const joined = await client.query(
      `SELECT
         e.id,
         e.tenant_id,
         e.prepaid_product_id,
         e.status,
         e.original_quantity,
         e.remaining_quantity,
         e.starts_at,
         e.expires_at,
         e.notes,
         p.name AS prepaid_product_name,
         p.description,
         p.product_type,
         p.eligible_service_ids,
         p.rules,
         p.credit_amount,
         p.session_count,
         p.minutes_total
       FROM customer_prepaid_entitlements e
       JOIN prepaid_products p
         ON p.id = e.prepaid_product_id
        AND p.tenant_id = e.tenant_id
       WHERE e.tenant_id=$1 AND e.id=$2
       LIMIT 1`,
      [tenantId, entitlement.id]
    );

    const normalized = joined.rows.length ? normalizeEntitlementRow(joined.rows[0]) : normalizeEntitlementRow(entitlement);

    return res.json({ entitlement: normalized });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("POST /customers/me/packages/:id/purchase error:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});
};
