'use strict';

// routes/plans.js
// ---------------------------------------------------------------------------
// Public pricing plan data for the marketing pricing page.
//
// GET /api/plans
//   → { plans: [{ code, name, price_yearly, price_monthly, currency_code,
//                 tier_order, tagline, description, features: [...] }, ...] }
//
// Only returns plans where is_public = true, ordered by tier_order.
// Feature list is embedded so the client can render the comparison matrix
// without a second round-trip.
//
// No auth required. Rate limit is the global rate limiter (PR-04).
// ---------------------------------------------------------------------------

const express = require('express');
const router  = express.Router();
const db      = require('../db');

router.get('/', async (req, res) => {
  try {
    const plansRes = await db.query(
      `SELECT id, code, name, price_yearly, price_monthly, currency_code,
              tier_order, tagline, description
       FROM saas_plans
       WHERE is_public = true
       ORDER BY tier_order ASC, id ASC`
    );

    const plans = plansRes.rows;
    if (plans.length === 0) {
      return res.json({ plans: [] });
    }

    // Single round-trip to load all features for all visible plans.
    const planIds = plans.map((p) => p.id);
    const featRes = await db.query(
      `SELECT plan_id, feature_key, enabled, limit_value, display_label
       FROM saas_plan_features
       WHERE plan_id = ANY($1::int[])
       ORDER BY feature_key`,
      [planIds]
    );

    const featuresByPlan = new Map();
    for (const row of featRes.rows) {
      if (!featuresByPlan.has(row.plan_id)) featuresByPlan.set(row.plan_id, []);
      featuresByPlan.get(row.plan_id).push({
        feature_key: row.feature_key,
        enabled: row.enabled,
        limit_value: row.limit_value,
        display_label: row.display_label,
      });
    }

    const body = {
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        price_yearly: p.price_yearly,
        price_monthly: p.price_monthly,
        currency_code: p.currency_code,
        tier_order: p.tier_order,
        tagline: p.tagline,
        description: p.description,
        features: featuresByPlan.get(p.id) || [],
      })),
    };

    // Short cache — plan data changes rarely. CDN can cache 60s.
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(body);
  } catch (err) {
    // Log and return empty (the pricing page has a client-side fallback).
    console.error('GET /plans failed:', err.message);
    res.status(500).json({ plans: [], error: 'plans_unavailable' });
  }
});

module.exports = router;
