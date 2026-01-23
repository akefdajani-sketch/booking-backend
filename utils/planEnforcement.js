// utils/planEnforcement.js
// Phase D1: Plans, Limits & Feature Gating (backend enforcement)
//
// Goals:
//  - Backend-enforced creation guards for services/staff/resources
//  - Trial bypass (14 days default)
//  - Minimal tables (no Stripe) that can later expand

const db = require("../db");

const DEFAULT_TRIAL_DAYS = 14;

// Canonical plan codes
const PLAN_CODES = {
  starter: "starter",
  growth: "growth",
  pro: "pro",
};

// Canonical feature keys
const FEATURE_KEYS = {
  limitServices: "limit_services",
  limitStaff: "limit_staff",
  limitResources: "limit_resources",
  calendarPlanning: "calendar_planning",
  savedPreferences: "saved_preferences",
  memberships: "memberships",
};

// Seed defaults (aligned to Phase D1 spec)
const PLAN_SEED = [
  {
    code: PLAN_CODES.starter,
    name: "Starter",
    features: {
      [FEATURE_KEYS.limitServices]: 5,
      [FEATURE_KEYS.limitStaff]: 3,
      [FEATURE_KEYS.limitResources]: 3,
      [FEATURE_KEYS.memberships]: false,
      [FEATURE_KEYS.savedPreferences]: false,
      [FEATURE_KEYS.calendarPlanning]: false,
    },
  },
  {
    code: PLAN_CODES.growth,
    name: "Growth",
    features: {
      [FEATURE_KEYS.limitServices]: 15,
      [FEATURE_KEYS.limitStaff]: 10,
      [FEATURE_KEYS.limitResources]: 10,
      [FEATURE_KEYS.memberships]: true,
      [FEATURE_KEYS.savedPreferences]: true,
      [FEATURE_KEYS.calendarPlanning]: false,
    },
  },
  {
    code: PLAN_CODES.pro,
    name: "Pro",
    features: {
      [FEATURE_KEYS.limitServices]: null, // unlimited
      [FEATURE_KEYS.limitStaff]: null,
      [FEATURE_KEYS.limitResources]: null,
      [FEATURE_KEYS.memberships]: true,
      [FEATURE_KEYS.savedPreferences]: true,
      [FEATURE_KEYS.calendarPlanning]: true,
    },
  },
];

let _ensured = false;

async function ensurePlanTables() {
  if (_ensured) return;

  // Minimal schemas (idempotent)
  await db.query(`
    CREATE TABLE IF NOT EXISTS saas_plans (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS saas_plan_features (
      id SERIAL PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES saas_plans(id) ON DELETE CASCADE,
      feature_key TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      limit_value INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(plan_id, feature_key)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_subscriptions (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES saas_plans(id) ON DELETE RESTRICT,
      -- Align to prod constraint (trialing/active/past_due/paused/canceled)
      status TEXT NOT NULL DEFAULT 'trialing',
      trial_ends_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      cancelled_at TIMESTAMPTZ
    );
  `);

  // IMPORTANT: CREATE TABLE IF NOT EXISTS does not add missing columns.
  // Production DBs may have an older tenant_subscriptions schema.
  // These ALTERs are safe/idempotent and prevent runtime 500s.
  await db.query(`ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'trialing';`);
  await db.query(`ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NOW();`);
  await db.query(`ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;`);

  // Seed plans + features (idempotent upsert)
  for (const p of PLAN_SEED) {
    const planRes = await db.query(
      `INSERT INTO saas_plans (code, name)
       VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [p.code, p.name]
    );
    const planId = planRes.rows[0].id;

    for (const [featureKey, v] of Object.entries(p.features)) {
      const enabled = typeof v === "boolean" ? v : true;
      const limitValue = typeof v === "number" ? v : null;
      await db.query(
        `INSERT INTO saas_plan_features (plan_id, feature_key, enabled, limit_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (plan_id, feature_key)
         DO UPDATE SET enabled = EXCLUDED.enabled, limit_value = EXCLUDED.limit_value`,
        [planId, featureKey, enabled, limitValue]
      );
    }
  }

  _ensured = true;
}

async function getLatestSubscription(tenantId) {
  await ensurePlanTables();

  const subRes = await db.query(
    `SELECT s.id, s.status, s.trial_ends_at, s.plan_id, p.code AS plan_code, p.name AS plan_name
       FROM tenant_subscriptions s
       JOIN saas_plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1
      ORDER BY COALESCE(s.started_at, NOW()) DESC, s.id DESC
      LIMIT 1`,
    [tenantId]
  );

  if (subRes.rows.length) return subRes.rows[0];

  // Create default subscription (Starter trial) for new tenants.
  const planIdRes = await db.query(`SELECT id FROM saas_plans WHERE code = $1 LIMIT 1`, [PLAN_CODES.starter]);
  const planId = planIdRes.rows[0]?.id;
  const trialEndsAtRes = await db.query(`SELECT NOW() + ($1 || ' days')::interval AS trial_ends_at`, [DEFAULT_TRIAL_DAYS]);
  const trialEndsAt = trialEndsAtRes.rows[0]?.trial_ends_at;

  const ins = await db.query(
    `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, trial_ends_at)
     VALUES ($1, $2, 'trialing', $3)
     RETURNING id`,
    [tenantId, planId, trialEndsAt]
  );

  const fresh = await db.query(
    `SELECT s.id, s.status, s.trial_ends_at, s.plan_id, p.code AS plan_code, p.name AS plan_name
       FROM tenant_subscriptions s
       JOIN saas_plans p ON p.id = s.plan_id
      WHERE s.id = $1`,
    [ins.rows[0].id]
  );
  return fresh.rows[0];
}

async function getPlanFeatures(planId) {
  await ensurePlanTables();
  const { rows } = await db.query(
    `SELECT feature_key, enabled, limit_value
       FROM saas_plan_features
      WHERE plan_id = $1`,
    [planId]
  );
  const out = {};
  for (const r of rows) {
    if (r.limit_value !== null && r.limit_value !== undefined) out[r.feature_key] = Number(r.limit_value);
    else out[r.feature_key] = Boolean(r.enabled);
  }
  return out;
}

function isTrialActive(sub) {
  if (!sub) return false;
  const status = String(sub.status || "").toLowerCase();
  // Back-compat: some early environments may have used 'trial'
  if (status !== "trialing" && status !== "trial") return false;
  if (!sub.trial_ends_at) return true;
  const d = new Date(sub.trial_ends_at);
  if (Number.isNaN(d.getTime())) return true;
  return d.getTime() > Date.now();
}

function planLimitValue(features, featureKey) {
  const v = features?.[featureKey];
  if (v === null || v === undefined) return null; // unlimited
  if (typeof v === "number") return v;
  // boolean false => treat as 0 when used as a limit
  if (v === false) return 0;
  return null;
}

async function getUsageCounts(tenantId) {
  const q = await db.query(
    `SELECT
      (SELECT COUNT(*)::int FROM services WHERE tenant_id = $1) AS services_count,
      (SELECT COUNT(*)::int FROM staff WHERE tenant_id = $1) AS staff_count,
      (SELECT COUNT(*)::int FROM resources WHERE tenant_id = $1) AS resources_count
    `,
    [tenantId]
  );
  return q.rows[0] || { services_count: 0, staff_count: 0, resources_count: 0 };
}

function kindToFeatureKey(kind) {
  if (kind === "services") return FEATURE_KEYS.limitServices;
  if (kind === "staff") return FEATURE_KEYS.limitStaff;
  if (kind === "resources") return FEATURE_KEYS.limitResources;
  return null;
}

async function assertWithinPlanLimit(tenantId, kind) {
  const featureKey = kindToFeatureKey(kind);
  if (!featureKey) return { ok: true };

  const sub = await getLatestSubscription(tenantId);
  // During active trial, allow everything.
  if (isTrialActive(sub)) return { ok: true, sub, features: null, usage: null };

  const features = await getPlanFeatures(sub.plan_id);
  const limit = planLimitValue(features, featureKey);
  if (limit == null) return { ok: true, sub, features };

  const usage = await getUsageCounts(tenantId);
  const current =
    kind === "services" ? usage.services_count : kind === "staff" ? usage.staff_count : usage.resources_count;

  if (current >= limit) {
    const err = new Error(`Plan limit reached for ${kind}`);
    err.status = 403;
    err.code = "PLAN_LIMIT_REACHED";
    err.kind = kind;
    err.limit = limit;
    err.current = current;
    err.plan_code = sub.plan_code;
    throw err;
  }

  return { ok: true, sub, features, usage };
}

async function getPlanSummaryForTenant(tenantId) {
  const sub = await getLatestSubscription(tenantId);
  const features = await getPlanFeatures(sub.plan_id);
  const usage = await getUsageCounts(tenantId);

  return {
    subscription: {
      status: sub.status,
      trial_ends_at: sub.trial_ends_at,
      plan_code: sub.plan_code,
      plan_name: sub.plan_name,
      is_trial_active: isTrialActive(sub),
    },
    limits: {
      services: planLimitValue(features, FEATURE_KEYS.limitServices),
      staff: planLimitValue(features, FEATURE_KEYS.limitStaff),
      resources: planLimitValue(features, FEATURE_KEYS.limitResources),
    },
    features,
    usage,
  };
}

module.exports = {
  ensurePlanTables,
  assertWithinPlanLimit,
  getPlanSummaryForTenant,
  PLAN_CODES,
  FEATURE_KEYS,
};
