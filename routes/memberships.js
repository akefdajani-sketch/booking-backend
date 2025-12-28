// routes/memberships.js
const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const db = pool; // keep db.query(...) working

const { getTenantIdFromSlug } = require("../utils/tenants");

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
async function resolveTenantId({ tenantId, tenantSlug }) {
  let resolvedTenantId = tenantId ? Number(tenantId) : null;

  if (!resolvedTenantId && tenantSlug) {
    resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
  }

  return resolvedTenantId || null;
}

// -----------------------------------------------------------------------------
// 1) GET membership plans
// GET /api/membership-plans?tenantSlug=... OR ?tenantId=...
// returns { plans: [...] }
// -----------------------------------------------------------------------------
router.get("/membership-plans", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;

    const resolvedTenantId = await resolveTenantId({ tenantId, tenantSlug });
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Unknown tenant.", plans: [] });
    }

    const result = await db.query(
      `
      SELECT
        id,
        tenant_id,
        name,
        description,
        billing_type,
        price,
        currency,
        included_minutes,
        included_uses,
        validity_days,
        is_active,
        created_at,
        updated_at
      FROM membership_plans
      WHERE tenant_id = $1
        AND is_active = true
      ORDER BY id ASC
      `,
      [resolvedTenantId]
    );

    return res.json({ plans: result.rows });
  } catch (err) {
    console.error("Error loading membership plans:", err);
    return res.status(500).json({ error: "Failed to load membership plans", plans: [] });
  }
});

// -----------------------------------------------------------------------------
// 2) GET customer memberships
// GET /api/customer-memberships?tenantSlug=...&customerId=...
// returns { memberships: [...] }
// -----------------------------------------------------------------------------
router.get("/customer-memberships", async (req, res) => {
  try {
    const { tenantSlug, tenantId, customerId } = req.query;

    if (!customerId) return res.json({ memberships: [] });

    const resolvedTenantId = await resolveTenantId({ tenantId, tenantSlug });
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Unknown tenant.", memberships: [] });
    }

    const result = await db.query(
      `
      SELECT
        cm.id,
        cm.tenant_id,
        cm.customer_id,
        cm.plan_id,
        cm.status,
        cm.start_at,
        cm.end_at,
        cm.minutes_remaining,
        cm.uses_remaining,
        cm.created_at,
        cm.updated_at,

        mp.name            AS plan_name,
        mp.description     AS plan_description,
        mp.billing_type    AS plan_billing_type,
        mp.price           AS plan_price,
        mp.currency        AS plan_currency,
        mp.included_minutes AS plan_included_minutes,
        mp.included_uses    AS plan_included_uses,
        mp.validity_days    AS plan_validity_days
      FROM customer_memberships cm
      JOIN membership_plans mp ON mp.id = cm.plan_id
      WHERE cm.tenant_id = $1
        AND cm.customer_id = $2
      ORDER BY cm.created_at DESC
      `,
      [resolvedTenantId, Number(customerId)]
    );

    return res.json({ memberships: result.rows });
  } catch (err) {
    console.error("Error loading customer memberships:", err);
    return res.status(500).json({ error: "Failed to load memberships", memberships: [] });
  }
});

// -----------------------------------------------------------------------------
// 3) Subscribe / buy a plan (creates customer_memberships row)
// POST /api/customer-memberships/subscribe
// body: { tenantSlug, tenantId?, customerId, planId }
// returns { membership: {...} }
// -----------------------------------------------------------------------------
router.post("/customer-memberships/subscribe", async (req, res) => {
  try {
    const { tenantSlug, tenantId, customerId, planId } = req.body || {};

    if (!customerId || !planId) {
      return res.status(400).json({ error: "customerId and planId are required" });
    }

    const resolvedTenantId = await resolveTenantId({ tenantId, tenantSlug });
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Unknown tenant." });
    }

    // Load plan (must belong to tenant and be active)
    const planRes = await db.query(
      `
      SELECT
        id,
        tenant_id,
        included_minutes,
        included_uses,
        validity_days,
        is_active
      FROM membership_plans
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1
      `,
      [Number(planId), resolvedTenantId]
    );

    if (!planRes.rows.length) {
      return res.status(400).json({ error: "Unknown planId." });
    }

    const plan = planRes.rows[0];
    if (!plan.is_active) {
      return res.status(400).json({ error: "Plan is not active." });
    }

    const includedMinutes = Number(plan.included_minutes || 0);
    const includedUses = Number(plan.included_uses || 0);
    const validityDays = Number(plan.validity_days || 0);

    // start/end
    const startAt = new Date();
    // if validityDays missing/0, choose a safe default (365) so it still works
    const endAt = new Date(startAt);
    endAt.setDate(endAt.getDate() + (validityDays > 0 ? validityDays : 365));

    // Create membership
    const insertRes = await db.query(
      `
      INSERT INTO customer_memberships
        (tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining)
      VALUES
        ($1, $2, $3, 'active', $4, $5, $6, $7)
      RETURNING
        id, tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining, created_at, updated_at
      `,
      [
        resolvedTenantId,
        Number(customerId),
        Number(planId),
        startAt,
        endAt,
        includedMinutes,
        includedUses,
      ]
    );

    return res.json({ membership: insertRes.rows[0] });
  } catch (err) {
    console.error("Error subscribing to plan:", err);
    return res.status(500).json({ error: "Failed to subscribe" });
  }
});

// -----------------------------------------------------------------------------
// 4) Ledger / usage history
// GET /api/customer-memberships/:id/ledger?tenantSlug=... OR tenantId=...
// returns { ledger: [...] }
// -----------------------------------------------------------------------------
router.get("/customer-memberships/:id/ledger", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;
    const membershipId = Number(req.params.id);

    if (!membershipId) return res.json({ ledger: [] });

    const resolvedTenantId = await resolveTenantId({ tenantId, tenantSlug });
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Unknown tenant.", ledger: [] });
    }

    // Ensure membership belongs to tenant (avoid cross-tenant access)
    const ownsRes = await db.query(
      `
      SELECT id
      FROM customer_memberships
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1
      `,
      [membershipId, resolvedTenantId]
    );
    if (!ownsRes.rows.length) return res.json({ ledger: [] });

    const result = await db.query(
      `
      SELECT
        id,
        tenant_id,
        customer_membership_id,
        booking_id,
        type,
        minutes_delta,
        uses_delta,
        note,
        created_at
      FROM membership_ledger
      WHERE customer_membership_id = $1
      ORDER BY created_at DESC
      `,
      [membershipId]
    );

    return res.json({ ledger: result.rows });
  } catch (err) {
    console.error("Error loading ledger:", err);
    return res.status(500).json({ error: "Failed to load ledger", ledger: [] });
  }
});

module.exports = router;
