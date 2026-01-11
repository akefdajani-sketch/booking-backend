// routes/tenantPlan.js
// Tenant Plan & Usage (Platform billing readiness - no enforcement)
//
// GET /api/tenant/:slug/plan
//
// Returns:
//  - current plan (code/name/price if present) + subscription status/trial dates
//  - plan features as key/value map
//  - usage snapshot (staff_count, services_count)
//
// Notes:
//  - This endpoint is tenant-scoped.
//  - Auth uses Google auth (same as Users & Roles).
//  - This is intentionally READ-ONLY (no Stripe / billing enforcement yet).

const express = require("express");
const router = express.Router();

const db = require("../db");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const ensureUser = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole } = require("../middleware/requireTenantRole");

// --- schema discovery (so we can work with your existing DB table/column names) ---
let _schemaCache = null;

async function getSchema() {
  if (_schemaCache) return _schemaCache;

  async function cols(tableName) {
    const { rows } = await db.query(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position ASC
      `,
      [tableName]
    );
    return rows.map((r) => r.column_name);
  }

  const schema = {
    saas_plans: await cols("saas_plans"),
    saas_plan_features: await cols("saas_plan_features"),
    tenant_subscriptions: await cols("tenant_subscriptions"),
  };

  // Helper to pick a column by preferred names
  function pick(tableCols, preferred) {
    for (const name of preferred) {
      if (tableCols.includes(name)) return name;
    }
    return null;
  }

  schema.pick = pick;

  // saas_plans columns
  schema.plans = {
    id: pick(schema.saas_plans, ["id", "plan_id"]),
    code: pick(schema.saas_plans, ["code", "plan_code", "slug"]),
    name: pick(schema.saas_plans, ["name", "plan_name", "title"]),
    price: pick(schema.saas_plans, ["monthly_price_usd", "monthly_price", "price_monthly", "price"]),
    createdAt: pick(schema.saas_plans, ["created_at"]),
  };

  // saas_plan_features columns
  schema.features = {
    id: pick(schema.saas_plan_features, ["id"]),
    planId: pick(schema.saas_plan_features, ["plan_id", "saas_plan_id", "platform_plan_id"]),
    key: pick(schema.saas_plan_features, ["feature_key", "key", "name"]),
    value: pick(schema.saas_plan_features, ["feature_value", "value", "json_value", "enabled", "limit_value"]),
    createdAt: pick(schema.saas_plan_features, ["created_at"]),
  };

  // tenant_subscriptions columns
  schema.subs = {
    id: pick(schema.tenant_subscriptions, ["id"]),
    tenantId: pick(schema.tenant_subscriptions, ["tenant_id"]),
    planId: pick(schema.tenant_subscriptions, ["plan_id", "saas_plan_id", "platform_plan_id"]),
    status: pick(schema.tenant_subscriptions, ["status"]),
    trialEndsAt: pick(schema.tenant_subscriptions, ["trial_ends_at", "trial_end_at"]),
    startedAt: pick(schema.tenant_subscriptions, ["started_at", "created_at"]),
    cancelledAt: pick(schema.tenant_subscriptions, ["cancelled_at", "canceled_at"]),
  };

  _schemaCache = schema;
  return schema;
}

async function resolveTenantIdFromParam(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug." });

    const tenantId = await getTenantIdFromSlug(slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found." });

    req.tenantSlug = slug;
    req.tenantId = tenantId;
    next();
  } catch (e) {
    console.error("resolveTenantIdFromParam error:", e);
    res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

router.get(
  "/:slug/plan",
  requireGoogleAuth,
  ensureUser,
  resolveTenantIdFromParam,
  requireTenantRole("viewer"),
  async (req, res) => {
    const tenantId = req.tenantId;

    try {
      const schema = await getSchema();

      // Guard: required tables/columns
      if (!schema.plans.id || !schema.plans.code || !schema.plans.name) {
        return res.status(500).json({
          error: "saas_plans table schema not recognized (missing id/code/name columns).",
        });
      }
      if (!schema.features.planId || !schema.features.key || !schema.features.value) {
        return res.status(500).json({
          error: "saas_plan_features table schema not recognized (missing plan_id/key/value columns).",
        });
      }
      if (!schema.subs.tenantId || !schema.subs.planId || !schema.subs.status) {
        return res.status(500).json({
          error: "tenant_subscriptions table schema not recognized (missing tenant_id/plan_id/status columns).",
        });
      }

      // 1) Current subscription + plan
      const planPriceSelect = schema.plans.price ? `p.${schema.plans.price} AS price` : `NULL::int AS price`;

      const subQuery = `
        SELECT
          s.${schema.subs.status} AS status,
          ${schema.subs.trialEndsAt ? `s.${schema.subs.trialEndsAt} AS trial_ends_at,` : `NULL::timestamptz AS trial_ends_at,`}
          ${schema.subs.startedAt ? `s.${schema.subs.startedAt} AS started_at,` : `NULL::timestamptz AS started_at,`}
          ${schema.subs.cancelledAt ? `s.${schema.subs.cancelledAt} AS cancelled_at,` : `NULL::timestamptz AS cancelled_at,`}
          p.${schema.plans.id} AS plan_id,
          p.${schema.plans.code} AS code,
          p.${schema.plans.name} AS name,
          ${planPriceSelect}
        FROM tenant_subscriptions s
        JOIN saas_plans p ON p.${schema.plans.id} = s.${schema.subs.planId}
        WHERE s.${schema.subs.tenantId} = $1
        ORDER BY COALESCE(${schema.subs.startedAt ? `s.${schema.subs.startedAt}` : `now()`}, now()) DESC
        LIMIT 1
      `;

      const subRes = await db.query(subQuery, [tenantId]);

      // If no subscription yet, return a clean "unsubscribed" response instead of 500.
      if (subRes.rows.length === 0) {
        const usageRes = await db.query(
          `
          SELECT
            (SELECT COUNT(*)::int FROM staff WHERE tenant_id = $1) AS staff_count,
            (SELECT COUNT(*)::int FROM services WHERE tenant_id = $1) AS services_count
          `,
          [tenantId]
        );

        return res.json({
          plan: null,
          features: {},
          usage: usageRes.rows[0] || { staff_count: 0, services_count: 0 },
        });
      }

      const sub = subRes.rows[0];

      // 2) Features map for this plan
      const featQuery = `
        SELECT ${schema.features.key} AS k, ${schema.features.value} AS v
        FROM saas_plan_features
        WHERE ${schema.features.planId} = $1
        ORDER BY ${schema.features.key} ASC
      `;
      const featRes = await db.query(featQuery, [sub.plan_id]);

      const features = {};
      for (const r of featRes.rows) {
        // if v is JSONB, pg will return object; if text/int/bool, it returns primitive
        features[r.k] = r.v;
      }

      // 3) Usage snapshot (informational only)
      const usageRes = await db.query(
        `
        SELECT
          (SELECT COUNT(*)::int FROM staff WHERE tenant_id = $1) AS staff_count,
          (SELECT COUNT(*)::int FROM services WHERE tenant_id = $1) AS services_count
        `,
        [tenantId]
      );

      return res.json({
        plan: {
          id: sub.plan_id,
          code: sub.code,
          name: sub.name,
          price: sub.price,
          status: sub.status,
          trialEndsAt: sub.trial_ends_at,
          startedAt: sub.started_at,
          cancelledAt: sub.cancelled_at,
        },
        features,
        usage: usageRes.rows[0] || { staff_count: 0, services_count: 0 },
      });
    } catch (e) {
      console.error("GET /api/tenant/:slug/plan error:", e);
      return res.status(500).json({ error: "Failed to load plan." });
    }
  }
);

module.exports = router;
