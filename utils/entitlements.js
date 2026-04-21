// utils/entitlements.js
// Entitlement enforcement — reads active subscription + plan features,
// syncs tenant_entitlements cache, and exposes per-request feature checks.
//
// Schema:
//   saas_plan_features (plan_id, feature_key, enabled, limit_value)
//   tenant_entitlements (tenant_id, feature_key, enabled, limit_value, source, ...)
//   tenant_subscriptions (tenant_id, plan_id, status, ...)
//
// Usage:
//   const { requireFeature } = require("../utils/entitlements");
//   router.post("/", requireFeature("memberships"), handler);
//
// ─────────────────────────────────────────────────────────────────────────────
// D4 FINISH v2 — schema corrections:
//
// Previous (broken) version queried `spf.feature_value` and wrote to
// `tenant_entitlements.feature_value` — neither column exists. The real column
// is `enabled` (BOOLEAN). This version uses the correct column name, matching
// the actual schema from migration 003 + 039.
//
// Behavior change: the entitlements cache is now fully optional. hasFeature()
// falls back to saas_plan_features directly whenever the cache is empty or
// errors. This makes the system correct-by-default for grandfathered tenants
// (who have no cache entries) and removes the cache as a correctness gate.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const db = require("../db");

// ── Canonical feature keys (must match saas_plan_features.feature_key) ────────
const FEATURES = Object.freeze({
  MEMBERSHIPS: "memberships",
  CALENDAR_PLANNING: "calendar_planning",
  SAVED_PREFERENCES: "saved_preferences",
  MULTI_LOCATION: "multi_location",
  ADVANCED_REPORTING: "advanced_reporting",
  CUSTOM_BRANDING: "custom_branding",
  API_ACCESS: "api_access",
  PRIORITY_SUPPORT: "priority_support",
  BOOKING_CODES: "booking_codes",
  PACKAGES: "packages",
  ONLINE_PAYMENTS: "online_payments",
  TAX_CONFIG: "tax_config",
  EMAIL_REMINDERS: "email_reminders",
  SMS_NOTIFICATIONS: "sms_notifications",
  WHATSAPP_NOTIFICATIONS: "whatsapp_notifications",
  WHITE_LABEL: "white_label",
  SSO: "sso",
});

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Fetch the active plan features for a tenant.
 * Returns [{ feature_key, enabled, limit_value }]
 *
 * Falls back to an empty set if no active/trialing subscription exists —
 * those tenants are implicitly unset and have no features.
 */
async function fetchPlanFeatures(tenantId) {
  const result = await db.query(
    `SELECT spf.feature_key, spf.enabled, spf.limit_value
     FROM tenant_subscriptions ts
     JOIN saas_plans sp ON sp.id = ts.plan_id
     JOIN saas_plan_features spf ON spf.plan_id = sp.id
     WHERE ts.tenant_id = $1
       AND ts.status IN ('active', 'trialing')
     ORDER BY spf.feature_key`,
    [tenantId]
  );
  return result.rows;
}

/**
 * Upsert tenant_entitlements from current plan features.
 * Called after a successful Stripe webhook activation (checkout.session.completed,
 * customer.subscription.updated, etc.).
 *
 * This is a cache-populating operation. If it fails or is never called, hasFeature()
 * still returns correct results via the saas_plan_features fallback path.
 */
async function ensureEntitlements(tenantId) {
  const features = await fetchPlanFeatures(tenantId);

  if (!features.length) {
    // No active subscription — clear all entitlements (downgrade path)
    await db.query(
      `DELETE FROM tenant_entitlements WHERE tenant_id = $1`,
      [tenantId]
    );
    return;
  }

  for (const { feature_key, enabled, limit_value } of features) {
    await db.query(
      `INSERT INTO tenant_entitlements
         (tenant_id, feature_key, enabled, limit_value, source, created_at)
       VALUES ($1, $2, $3, $4, 'plan', NOW())
       ON CONFLICT (tenant_id, feature_key)
       DO UPDATE SET enabled     = EXCLUDED.enabled,
                     limit_value = EXCLUDED.limit_value,
                     source      = EXCLUDED.source`,
      [tenantId, feature_key, enabled, limit_value]
    );
  }
}

/**
 * Check whether a tenant has a specific feature enabled.
 *
 * Resolution order:
 *   1. Trial bypass: tenant has an active 'trialing' subscription → true
 *   2. Entitlements cache: a row exists in tenant_entitlements → use its enabled value
 *   3. D4.6 fallback: query saas_plan_features via tenant_subscriptions → use its enabled value
 *   4. No match anywhere → false
 *
 * The fallback (step 3) is the critical path that protects tenants whose
 * tenant_entitlements cache has not been populated — including grandfathered
 * tenants that never ran through a Stripe webhook.
 *
 * Returns boolean. Never throws; on DB errors, returns false (deny-by-default
 * is safer than a middleware crash that fails open everywhere).
 */
async function hasFeature(tenantId, featureKey) {
  try {
    // 1. Trial bypass
    const trialCheck = await db.query(
      `SELECT 1 FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status = 'trialing'
       LIMIT 1`,
      [tenantId]
    );
    if (trialCheck.rows.length) return true;

    // 2. Entitlements cache
    const cacheResult = await db.query(
      `SELECT enabled FROM tenant_entitlements
       WHERE tenant_id = $1 AND feature_key = $2
       LIMIT 1`,
      [tenantId, featureKey]
    );
    if (cacheResult.rows.length) {
      return Boolean(cacheResult.rows[0].enabled);
    }

    // 3. D4.6 fallback — query plan features directly
    const fallback = await db.query(
      `SELECT spf.enabled
       FROM tenant_subscriptions ts
       JOIN saas_plans sp ON sp.id = ts.plan_id
       JOIN saas_plan_features spf ON spf.plan_id = sp.id
       WHERE ts.tenant_id = $1
         AND ts.status IN ('active', 'trialing')
         AND spf.feature_key = $2
       ORDER BY ts.started_at DESC NULLS LAST
       LIMIT 1`,
      [tenantId, featureKey]
    );
    if (!fallback.rows.length) return false;
    return Boolean(fallback.rows[0].enabled);
  } catch (err) {
    // Log but do not crash — fail closed (safer than opening all gates).
    // Middleware's try/catch handles the subsequent behavior.
    // eslint-disable-next-line no-console
    console.error("[entitlements] hasFeature error:", err.message);
    return false;
  }
}

// ── Express middleware ─────────────────────────────────────────────────────────

/**
 * requireFeature(featureKey) — returns an Express middleware that returns 403
 * if the authenticated tenant does not have the feature enabled.
 *
 * Must be used after requireTenant (so req.tenantId is populated).
 *
 * Example:
 *   router.post("/", requireTenant, requireFeature("memberships"), handler);
 */
function requireFeature(featureKey) {
  return async function featureGate(req, res, next) {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: "Tenant not identified." });
    }

    try {
      const allowed = await hasFeature(tenantId, featureKey);
      if (!allowed) {
        return res.status(403).json({
          error: "Feature not available on your current plan.",
          code: "FEATURE_NOT_AVAILABLE",
          feature: featureKey,
        });
      }
      return next();
    } catch (err) {
      // hasFeature() already catches its own errors and returns false — but
      // if something else throws (JWT parse, etc.), fail closed by returning
      // 500 rather than opening the gate silently.
      // eslint-disable-next-line no-console
      console.error("[entitlements] feature gate error:", err);
      return res.status(500).json({ error: "Feature gate check failed." });
    }
  };
}

module.exports = {
  FEATURES,
  fetchPlanFeatures,
  ensureEntitlements,
  hasFeature,
  requireFeature,
};
