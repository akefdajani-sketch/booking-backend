// routes/customerMemberships.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { requireTenant } = require("../middleware/requireTenant");

// GET /api/customer-memberships?tenantSlug|tenantId&customerId=
router.get("/", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.query.customerId);

    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.json({ memberships: [] });
    }

    // Customer must belong to tenant
    const c = await db.query(
      `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [customerId, tenantId]
    );
    if (!c.rows.length) return res.json({ memberships: [] });

    const r = await db.query(
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
        mp.name AS plan_name,
        mp.description AS plan_description,
        mp.price AS plan_price,
        mp.currency AS plan_currency,
        mp.included_minutes,
        mp.included_uses,
        mp.validity_days
      FROM customer_memberships cm
      JOIN membership_plans mp
        ON mp.id = cm.plan_id
       AND mp.tenant_id = $1
      WHERE cm.tenant_id = $1
        AND cm.customer_id = $2
      ORDER BY cm.start_at DESC NULLS LAST, cm.created_at DESC NULLS LAST
      `,
      [tenantId, customerId]
    );

    return res.json({ memberships: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships error:", err);
    return res.status(500).json({ error: "Failed to load memberships." });
  }
});

// POST /api/customer-memberships/subscribe?tenantSlug=...
// Body: { customerId, membershipPlanId }
router.post("/subscribe", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.body?.customerId);
    const membershipPlanId = Number(req.body?.membershipPlanId);

    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customerId." });
    }
    if (!Number.isFinite(membershipPlanId) || membershipPlanId <= 0) {
      return res.status(400).json({ error: "Invalid membershipPlanId." });
    }

    // Customer must belong to tenant
    const c = await db.query(
      `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [customerId, tenantId]
    );
    if (!c.rows.length) {
      return res.status(400).json({ error: "Unknown customer for tenant." });
    }

    // Plan must belong to tenant and be active
    const p = await db.query(
      `
      SELECT id, name, included_minutes, included_uses, validity_days, is_active
      FROM membership_plans
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1
      `,
      [membershipPlanId, tenantId]
    );
    if (!p.rows.length) return res.status(404).json({ error: "Plan not found for tenant." });

    const plan = p.rows[0];
    if (!plan.is_active) return res.status(400).json({ error: "Plan is not active." });

    const minutesRemaining = Number(plan.included_minutes || 0);
    const usesRemaining = Number(plan.included_uses || 0);
    const validityDays = Number(plan.validity_days || 30);

    const startAt = new Date();
    const endAt = new Date(startAt);
    endAt.setDate(endAt.getDate() + validityDays);

    // Insert membership (NOTE: plan_id + minutes_remaining + uses_remaining)
    const ins = await db.query(
      `
      INSERT INTO customer_memberships
        (tenant_id, customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining)
      VALUES
        ($1, $2, $3, 'active', $4, $5, $6, $7)
      RETURNING *
      `,
      [tenantId, customerId, membershipPlanId, startAt.toISOString(), endAt.toISOString(), minutesRemaining, usesRemaining]
    );

    const membership = ins.rows[0];

    // Ledger entry (matches your table: customer_membership_id, minutes_delta, uses_delta)
    await db.query(
      `
      INSERT INTO membership_ledger
        (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
      VALUES
        ($1, $2, NULL, 'grant', $3, $4, $5)
      `,
      [tenantId, membership.id, minutesRemaining, usesRemaining, `Initial grant for ${plan.name}`]
    );

    return res.json({ membership });
  } catch (err) {
    console.error("POST /api/customer-memberships/subscribe error:", err);
    return res.status(500).json({ error: "Failed to subscribe." });
  }
});

// GET /api/customer-memberships/:id/ledger?tenantSlug=...
router.get("/:id/ledger", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const membershipId = Number(req.params.id);

    if (!Number.isFinite(membershipId) || membershipId <= 0) {
      return res.status(400).json({ error: "Invalid membership id." });
    }

    // Membership must belong to tenant
    const m = await db.query(
      `SELECT id FROM customer_memberships WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [membershipId, tenantId]
    );
    if (!m.rows.length) return res.status(404).json({ error: "Membership not found for tenant." });

    const r = await db.query(
      `
      SELECT
        id,
        created_at,
        booking_id,
        type,
        minutes_delta,
        uses_delta,
        note
      FROM membership_ledger
      WHERE tenant_id = $1
        AND customer_membership_id = $2
      ORDER BY created_at DESC
      LIMIT 200
      `,
      [tenantId, membershipId]
    );

    return res.json({ ledger: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships/:id/ledger error:", err);
    return res.status(500).json({ error: "Failed to load ledger." });
  }
});

module.exports = router;
