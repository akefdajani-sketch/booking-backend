'use strict';

// utils/tenantSubscriptionEnricher.js
// PR F (Trial lifecycle hardening).
//
// Shared helper that loads subscription state for a list of tenants and
// returns a map keyed by tenant_id. Used by:
//   • routes/tenants/core.js     — to enrich GET /api/tenants response
//   • routes/ownerDashboard.js   — already does its own version inline
//   • future admin tooling that needs subscription state per tenant
//
// Why a separate helper:
//   1. The "latest subscription per tenant" query is non-trivial (DISTINCT ON
//      with ordering on COALESCE(started_at, NOW())) — encoding it once
//      avoids drift if we touch the schema later.
//   2. Schema-compat: trial_warning_sent_at column may not exist on environments
//      that haven't run migration 053 yet. The helper degrades gracefully
//      (returns NULL for that field) so /api/tenants doesn't 500 on stale
//      schemas.
//   3. The display-friendly shape (planCode, planName, status, trialEndsAt,
//      trialEndsInDays, derivedBadge) is decided here, not in the route, so
//      the frontend has a stable contract.

const db = require('../db');

let __hasTrialWarningCol = null;

async function hasTrialWarningColumn() {
  if (__hasTrialWarningCol !== null) return __hasTrialWarningCol;
  try {
    const { rows } = await db.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_name = 'tenant_subscriptions'
          AND column_name = 'trial_warning_sent_at'
        LIMIT 1`
    );
    __hasTrialWarningCol = rows.length > 0;
  } catch {
    __hasTrialWarningCol = false;
  }
  return __hasTrialWarningCol;
}

/**
 * Compute a small "badge" string the frontend can render directly. The
 * frontend can also derive its own badge from the raw fields if it wants
 * different copy — this is just the default.
 */
function deriveBadge({ status, trialEndsInDays }) {
  if (!status) return { tone: 'neutral', label: 'No subscription' };
  if (status === 'past_due') return { tone: 'bad', label: 'Past due' };
  if (status === 'canceled') return { tone: 'neutral', label: 'Canceled' };
  if (status === 'unpaid') return { tone: 'bad', label: 'Unpaid' };
  if (status === 'trialing') {
    if (trialEndsInDays == null) return { tone: 'good', label: 'Trial' };
    if (trialEndsInDays <= 0) return { tone: 'warn', label: 'Trial · ending today' };
    if (trialEndsInDays === 1) return { tone: 'warn', label: 'Trial · ends tomorrow' };
    if (trialEndsInDays <= 3) return { tone: 'warn', label: `Trial · ${trialEndsInDays}d left` };
    return { tone: 'good', label: `Trial · ${trialEndsInDays}d left` };
  }
  if (status === 'active') return { tone: 'good', label: 'Active' };
  return { tone: 'neutral', label: status };
}

/**
 * @param {number[]} tenantIds — list of tenant IDs to fetch state for. Pass
 *   an empty array to get an empty map back. Pass null to fetch ALL tenants
 *   (used by the trial-sweep job).
 * @returns {Promise<Map<number, SubscriptionState>>}
 *   SubscriptionState shape:
 *     { planCode, planName, status, startedAt, trialEndsAt, cancelledAt,
 *       trialWarningSentAt, trialEndsInDays, badge: { tone, label } }
 */
async function getSubscriptionsForTenants(tenantIds) {
  const all = tenantIds === null;
  if (!all && (!Array.isArray(tenantIds) || tenantIds.length === 0)) {
    return new Map();
  }

  const includeWarning = await hasTrialWarningColumn();
  const warningSelect = includeWarning ? 'ts.trial_warning_sent_at' : 'NULL::timestamptz AS trial_warning_sent_at';

  // DISTINCT ON gets the latest subscription per tenant. Joined with saas_plans
  // for plan name/code.
  const sql = `
    SELECT DISTINCT ON (ts.tenant_id)
      ts.tenant_id,
      ts.status,
      ts.started_at,
      ts.trial_ends_at,
      ts.cancelled_at,
      ${warningSelect},
      sp.code  AS plan_code,
      sp.name  AS plan_name
    FROM tenant_subscriptions ts
    LEFT JOIN saas_plans sp ON sp.id = ts.plan_id
    ${all ? '' : 'WHERE ts.tenant_id = ANY($1::int[])'}
    ORDER BY ts.tenant_id, COALESCE(ts.started_at, NOW()) DESC
  `;
  const params = all ? [] : [tenantIds];
  const { rows } = await db.query(sql, params);

  const byId = new Map();
  const now = Date.now();
  for (const r of rows) {
    let trialEndsInDays = null;
    if (r.trial_ends_at) {
      const dt = new Date(r.trial_ends_at).getTime();
      trialEndsInDays = Math.floor((dt - now) / (1000 * 60 * 60 * 24));
    }
    const state = {
      planCode: r.plan_code || null,
      planName: r.plan_name || null,
      status: r.status || null,
      startedAt: r.started_at || null,
      trialEndsAt: r.trial_ends_at || null,
      cancelledAt: r.cancelled_at || null,
      trialWarningSentAt: r.trial_warning_sent_at || null,
      trialEndsInDays,
    };
    state.badge = deriveBadge(state);
    byId.set(r.tenant_id, state);
  }
  return byId;
}

module.exports = {
  getSubscriptionsForTenants,
  deriveBadge, // exported for tests + edge-case callers
};
