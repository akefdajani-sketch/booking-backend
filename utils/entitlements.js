// utils/entitlements.js
// Entitlement enforcement — reads active subscription + plan features,
// syncs tenant_entitlements, and exposes per-request feature checks.
//
// Usage:
//   const { requireFeature } = require("../utils/entitlements");
//   router.post("/", requireFeature("memberships"), handler);

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
});

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Fetch the active plan features for a tenant.
 * Falls back to an empty set if no active subscription exists (free / unset tenants
 * are implicitly on Starter; Starter has no premium features).
 */
async function fetchPlanFeatures(tenantId) {
  const result = await db.query(
    `SELECT spf.feature_key, spf.feature_value
     FROM tenant_subscriptions ts
     JOIN saas_plans sp ON sp.id = ts.plan_id
     JOIN saas_plan_features spf ON spf.plan_id = sp.id
     WHERE ts.tenant_id = $1
       AND ts.status IN ('active', 'trialing')
     ORDER BY spf.feature_key`,
    [tenantId]
  );
  return result.rows; // [{ feature_key, feature_value }]
}

/**
 * Upsert tenant_entitlements from current plan features.
 * Called after a successful Stripe webhook activation.
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

  for (const { feature_key, feature_value } of features) {
    await db.query(
      `INSERT INTO tenant_entitlements (tenant_id, feature_key, feature_value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, feature_key)
       DO UPDATE SET feature_value = EXCLUDED.feature_value,
                     updated_at    = EXCLUDED.updated_at`,
      [tenantId, feature_key, feature_value]
    );
  }
}

/**
 * Check whether a tenant has a specific feature enabled.
 * Returns true if the entitlement row exists and feature_value is truthy.
 */
async function hasFeature(tenantId, featureKey) {
  // Also honour trial bypass — tenants in trial get all features
  const trialCheck = await db.query(
    `SELECT 1 FROM tenant_subscriptions
     WHERE tenant_id = $1 AND status = 'trialing'
     LIMIT 1`,
    [tenantId]
  );
  if (trialCheck.rows.length) return true;

  const result = await db.query(
    `SELECT feature_value FROM tenant_entitlements
     WHERE tenant_id = $1 AND feature_key = $2
     LIMIT 1`,
    [tenantId, featureKey]
  );
  if (!result.rows.length) return false;

  const val = result.rows[0].feature_value;
  // Boolean-like: "true", true, 1, "1", numeric string > 0
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val > 0;
  if (typeof val === "string") {
    if (val.toLowerCase() === "true") return true;
    if (val.toLowerCase() === "false") return false;
    const n = Number(val);
    return !isNaN(n) && n > 0;
  }
  return Boolean(val);
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
          error: `Feature not available on your current plan.`,
          code: "FEATURE_NOT_AVAILABLE",
          feature: featureKey,
        });
      }
      return next();
    } catch (err) {
      // Log but do not block — fail open is safer than killing all requests
      // if the entitlements table has a transient issue
      console.error("[entitlements] feature check error:", err);
      return next();
    }
  };
}

module.exports = {
  FEATURES,
  ensureEntitlements,
  hasFeature,
  requireFeature,
};
