'use strict';

// routes/ownerDashboard.js
// PR E (Owner Dashboard: real overview metrics).
//
// Replaces the mock data in /owner/dashboard's Overview tab with live
// platform-wide metrics queried directly from the production database.
//
// Endpoint:
//   GET /api/owner-dashboard/overview
//
// Auth: ADMIN_API_KEY only (requireAdmin). The frontend reaches here through
// the existing owner-cookie-authed proxy at app/api/owner/dashboard-overview/.
//
// Returns six KPIs + two trend series + a recent-activity feed:
//   {
//     kpis: [
//       { key, label, value, sublabel, deltaLabel?, tone? },
//       ... 6 entries
//     ],
//     trends: [
//       { key: 'bookings7d', label, points: number[7], footerLeft, footerRight },
//       { key: 'revenue30d', label, points: number[30], footerLeft, footerRight }
//     ],
//     activity: [ { id, when, title, detail }, ... up to 12 ],
//     generatedAt: ISO timestamp
//   }
//
// Designed for cheap evaluation — every query is a single round-trip aggregate.
// No N+1, no per-tenant fan-out. Total cost on Birdie's prod DB at ~50 tenants
// is sub-100ms.
//
// All money is reported in USD cents (matching tenant_invoices.amount_cents)
// because Stripe is single-currency for the SaaS plans (locked in D4).

const express = require('express');
const router  = express.Router();

const db          = require('../db');
const logger      = require('../utils/logger');
const requireAdmin = require('../middleware/requireAdmin');

// ─── Helper: bucket counts/sums by day with zero-fill ────────────────────────

/**
 * Given a list of {bucket: Date, value: number} rows already sorted ascending
 * by bucket, return an array of `length` numbers ending at `endDate` (today),
 * with zero-fill for days that have no data. Inclusive of today.
 */
function bucketByDay(rows, lengthDays, endDate = new Date()) {
  const points = new Array(lengthDays).fill(0);

  // Build a date → value map for O(1) lookup
  const byDate = new Map();
  for (const row of rows) {
    const key = new Date(row.bucket).toISOString().slice(0, 10); // YYYY-MM-DD
    byDate.set(key, Number(row.value) || 0);
  }

  // Walk lengthDays back from endDate, populating from the map
  for (let i = 0; i < lengthDays; i++) {
    const d = new Date(endDate);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - (lengthDays - 1 - i));
    const key = d.toISOString().slice(0, 10);
    points[i] = byDate.get(key) || 0;
  }

  return points;
}

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const dt = (Date.now() - t) / 1000;
  if (dt < 60) return 'just now';
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  if (dt < 86400 * 7) return `${Math.floor(dt / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── KPI fetchers — each returns a small projection ──────────────────────────

async function fetchKpis() {
  // Run six queries in parallel — they don't depend on each other.
  const [
    activeTenants,
    mrrCents,
    bookingsToday,
    revenueTodayCents,
    pastDue,
    trialsEndingSoon,
    activationRate, // L: activated tenants / tenants ≥7d old
  ] = await Promise.all([
    // 1. Active tenants — any tenant with status in ('active','trialing') on
    //    their most-recent subscription. Uses DISTINCT ON to pick the latest
    //    sub per tenant.
    db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, status
        FROM tenant_subscriptions
        ORDER BY tenant_id, COALESCE(started_at, NOW()) DESC
      )
      SELECT COUNT(*)::int AS n
      FROM latest
      WHERE status IN ('active','trialing')
    `).then(r => r.rows[0]?.n || 0),

    // 2. MRR — sum of monthly-equivalent prices for tenants on active subs.
    //    price_yearly/12 if yearly, price_monthly if monthly. We don't store
    //    cycle on the subscription, so approximate using monthly_price as
    //    fallback when yearly is null. Returned in USD cents (×100).
    db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, plan_id, status
        FROM tenant_subscriptions
        ORDER BY tenant_id, COALESCE(started_at, NOW()) DESC
      )
      SELECT COALESCE(SUM(
        CASE
          WHEN sp.price_yearly IS NOT NULL  THEN ROUND(sp.price_yearly * 100 / 12.0)
          WHEN sp.price_monthly IS NOT NULL THEN ROUND(sp.price_monthly * 100)
          ELSE 0
        END
      ), 0)::bigint AS mrr_cents
      FROM latest l
      JOIN saas_plans sp ON sp.id = l.plan_id
      WHERE l.status = 'active'
    `).then(r => Number(r.rows[0]?.mrr_cents || 0)),

    // 3. Bookings today — across all tenants, status=confirmed, start_time today.
    db.query(`
      SELECT COUNT(*)::int AS n
      FROM bookings
      WHERE status = 'confirmed'
        AND start_time::date = CURRENT_DATE
    `).then(r => r.rows[0]?.n || 0),

    // 4. Revenue today — from tenant_invoices.amount_cents where paid_at today.
    db.query(`
      SELECT COALESCE(SUM(amount_cents), 0)::bigint AS cents
      FROM tenant_invoices
      WHERE status = 'paid'
        AND paid_at::date = CURRENT_DATE
    `).then(r => Number(r.rows[0]?.cents || 0)),

    // 5. Past due — tenants with status='past_due' on latest sub.
    db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, status
        FROM tenant_subscriptions
        ORDER BY tenant_id, COALESCE(started_at, NOW()) DESC
      )
      SELECT COUNT(*)::int AS n FROM latest WHERE status = 'past_due'
    `).then(r => r.rows[0]?.n || 0),

    // 6. Trials ending in next 3 days — gives ak a heads-up for outreach.
    db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, status, trial_ends_at
        FROM tenant_subscriptions
        ORDER BY tenant_id, COALESCE(started_at, NOW()) DESC
      )
      SELECT COUNT(*)::int AS n
      FROM latest
      WHERE status = 'trialing'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at <= NOW() + INTERVAL '3 days'
        AND trial_ends_at >= NOW()
    `).then(r => r.rows[0]?.n || 0),

    // 7. L: Activation rate — % of tenants ≥7 days old that have completed
    //    setup. A tenant is "activated" if it has at least one service AND
    //    one resource AND one booking. We deliberately use a stricter
    //    definition than the in-app checklist (6 milestones) so the KPI
    //    measures "actually using the product" not "filled out forms".
    //
    //    Cohort cutoff = 7d so we don't penalize tenants who just signed up.
    //    Returns { numerator, denominator } so the frontend can render
    //    "12/18 tenants (67%)".
    db.query(`
      WITH cohort AS (
        SELECT DISTINCT ON (ts.tenant_id) ts.tenant_id, ts.started_at
          FROM tenant_subscriptions ts
        ORDER BY ts.tenant_id, COALESCE(ts.started_at, NOW()) DESC
      ),
      eligible AS (
        SELECT tenant_id FROM cohort
         WHERE started_at IS NOT NULL
           AND started_at < NOW() - INTERVAL '7 days'
      ),
      activated AS (
        SELECT e.tenant_id FROM eligible e
         WHERE EXISTS (SELECT 1 FROM services s  WHERE s.tenant_id  = e.tenant_id AND s.active = true)
           AND EXISTS (SELECT 1 FROM resources r WHERE r.tenant_id  = e.tenant_id AND r.active = true)
           AND EXISTS (SELECT 1 FROM bookings  b WHERE b.tenant_id  = e.tenant_id AND b.deleted_at IS NULL)
      )
      SELECT
        (SELECT COUNT(*)::int FROM eligible)  AS denominator,
        (SELECT COUNT(*)::int FROM activated) AS numerator
    `).then(r => {
      const row = r.rows[0] || { numerator: 0, denominator: 0 };
      const num = Number(row.numerator || 0);
      const den = Number(row.denominator || 0);
      const pct = den > 0 ? Math.round((num / den) * 100) : 0;
      return { numerator: num, denominator: den, pct };
    }),
  ]);

  // Format helpers
  const fmtMoney = (cents) => {
    const v = cents / 100;
    if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
    return `$${Math.round(v)}`;
  };

  return [
    {
      key: 'activeTenants',
      label: 'Active tenants',
      value: activeTenants,
      sublabel: 'paying + trialing',
      tone: activeTenants > 0 ? 'good' : 'neutral',
    },
    {
      key: 'mrr',
      label: 'MRR',
      value: fmtMoney(mrrCents),
      sublabel: 'monthly recurring',
      tone: mrrCents > 0 ? 'good' : 'neutral',
    },
    {
      key: 'bookingsToday',
      label: 'Bookings today',
      value: bookingsToday,
      sublabel: 'across all tenants',
      tone: 'neutral',
    },
    {
      key: 'revenueToday',
      label: 'Revenue today',
      value: fmtMoney(revenueTodayCents),
      sublabel: 'invoices paid',
      tone: revenueTodayCents > 0 ? 'good' : 'neutral',
    },
    {
      key: 'pastDue',
      label: 'Past due',
      value: pastDue,
      sublabel: 'subscriptions',
      tone: pastDue > 0 ? 'warn' : 'neutral',
    },
    {
      key: 'trialsEnding',
      label: 'Trials ending',
      value: trialsEndingSoon,
      sublabel: 'within 3 days',
      tone: trialsEndingSoon > 0 ? 'warn' : 'neutral',
    },
    {
      key: 'activationRate',
      label: 'Activation rate',
      value: `${activationRate.pct}%`,
      sublabel: `${activationRate.numerator} / ${activationRate.denominator} tenants ≥7 days old`,
      tone:
        activationRate.denominator === 0
          ? 'neutral'
          : activationRate.pct >= 60
            ? 'good'
            : activationRate.pct >= 30
              ? 'neutral'
              : 'warn',
    },
  ];
}

async function fetchTrends() {
  // 7-day bookings, 30-day revenue.
  const [bookings7d, revenue30d] = await Promise.all([
    db.query(`
      SELECT date_trunc('day', start_time) AS bucket, COUNT(*)::int AS value
      FROM bookings
      WHERE status = 'confirmed'
        AND start_time >= CURRENT_DATE - INTERVAL '6 days'
        AND start_time <  CURRENT_DATE + INTERVAL '1 day'
      GROUP BY bucket
      ORDER BY bucket ASC
    `).then(r => r.rows),

    db.query(`
      SELECT date_trunc('day', paid_at) AS bucket, COALESCE(SUM(amount_cents), 0)::bigint AS value
      FROM tenant_invoices
      WHERE status = 'paid'
        AND paid_at >= CURRENT_DATE - INTERVAL '29 days'
        AND paid_at <  CURRENT_DATE + INTERVAL '1 day'
      GROUP BY bucket
      ORDER BY bucket ASC
    `).then(r => r.rows),
  ]);

  const bookingsPoints = bucketByDay(bookings7d, 7);
  const revenuePoints  = bucketByDay(revenue30d, 30); // cents

  const total7d = bookingsPoints.reduce((s, n) => s + n, 0);
  const total30dCents = revenuePoints.reduce((s, n) => s + n, 0);

  return [
    {
      key: 'bookings7d',
      label: 'Bookings (last 7 days)',
      points: bookingsPoints,
      footerLeft: `7d total: ${total7d}`,
      footerRight: '',
    },
    {
      key: 'revenue30d',
      label: 'Revenue (last 30 days)',
      // Trend chart wants relative values — divide by 100 so $ values look
      // sane in tooltips. The Sparkline only uses min/max for scaling.
      points: revenuePoints.map(c => Math.round(c / 100)),
      footerLeft: `30d gross: $${(total30dCents / 100).toLocaleString()}`,
      footerRight: '',
    },
  ];
}

async function fetchActivity() {
  // Latest 12 platform events: new tenants, paid invoices, recent webhook events.
  const [tenantsRecent, invoicesRecent] = await Promise.all([
    db.query(`
      SELECT id, slug, name, created_at
      FROM tenants
      ORDER BY created_at DESC NULLS LAST
      LIMIT 6
    `).then(r => r.rows),

    db.query(`
      SELECT i.id, i.amount_cents, i.currency, i.paid_at, t.slug, t.name
      FROM tenant_invoices i
      JOIN tenants t ON t.id = i.tenant_id
      WHERE i.status = 'paid'
        AND i.paid_at IS NOT NULL
      ORDER BY i.paid_at DESC
      LIMIT 6
    `).then(r => r.rows),
  ]);

  const items = [];

  for (const t of tenantsRecent) {
    items.push({
      id: `tenant_${t.id}`,
      when: relTime(t.created_at),
      at: t.created_at,
      sortKey: new Date(t.created_at || 0).getTime(),
      title: 'Tenant created',
      detail: `${t.slug || t.name || `tenant ${t.id}`}`,
    });
  }

  for (const i of invoicesRecent) {
    const v = (Number(i.amount_cents || 0) / 100);
    const amount = v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`;
    items.push({
      id: `inv_${i.id}`,
      when: relTime(i.paid_at),
      at: i.paid_at,
      sortKey: new Date(i.paid_at).getTime(),
      title: 'Invoice paid',
      detail: `${i.slug || i.name || 'tenant'} • ${amount} ${(i.currency || 'usd').toUpperCase()}`,
    });
  }

  // Sort merged feed by recency, drop sortKey before returning
  return items
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, 12)
    .map(({ sortKey, ...rest }) => rest);
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.get('/overview', requireAdmin, async (req, res) => {
  try {
    const [kpis, trends, activity] = await Promise.all([
      fetchKpis(),
      fetchTrends(),
      fetchActivity(),
    ]);

    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.json({
      kpis,
      trends,
      activity,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'GET /api/owner-dashboard/overview failed');
    return res.status(500).json({ error: 'Failed to load owner overview.' });
  }
});

module.exports = router;
