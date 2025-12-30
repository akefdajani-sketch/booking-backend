// routes/customerMemberships.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { requireTenant } = require("../middleware/requireTenant");

// GET /api/customer-memberships?tenantSlug|tenantId&customerId=
// P1: customer must belong to tenant, memberships must be tenant-scoped
router.get("/", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = Number(req.query.customerId);

    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res.json({ memberships: [] });
    }

    // ✅ P1: customer must belong to tenant
    const cRes = await db.query(
      `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [customerId, tenantId]
    );
    if (!cRes.rows.length) return res.json({ memberships: [] });

    const r = await db.query(
      `
      SELECT
        cm.id,
        cm.tenant_id,
        cm.customer_id,
        cm.membership_plan_id,
        cm.remaining_minutes,
        cm.remaining_uses,
        cm.expires_at,
        cm.status,
        cm.created_at,
        mp.name AS plan_name,
        mp.description AS plan_description,
        mp.price AS plan_price,
        mp.currency AS plan_currency,
        mp.included_minutes AS plan_included_minutes,
        mp.included_uses AS plan_included_uses,
        mp.validity_days AS plan_validity_days,
        mp.is_active AS plan_is_active
      FROM customer_memberships cm
      JOIN membership_plans mp
        ON mp.id = cm.membership_plan_id
       AND mp.tenant_id = $1
      WHERE cm.tenant_id = $1
        AND cm.customer_id = $2
      ORDER BY cm.created_at DESC
      `,
      [tenantId, customerId]
    );

    return res.json({ memberships: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships error:", err);
    return res.status(500).json({ error: "Failed to load memberships." });
  }
});

// POST /api/customer-memberships/subscribe
// Body: { tenantSlug|tenantId, customerId, membershipPlanId }
// P1: tenant resolved from slug/id; customer + plan must belong to tenant
router.post("/subscribe", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { customerId, membershipPlanId } = req.body || {};

    const cid = Number(customerId);
    const planId = Number(membershipPlanId);

    if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(planId) || planId <= 0) {
      return res.status(400).json({ error: "Invalid customerId/membershipPlanId." });
    }

    // ✅ P1: customer must belong to tenant
    const cRes = await db.query(
      `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [cid, tenantId]
    );
    if (!cRes.rows.length) return res.status(400).json({ error: "Unknown customer for tenant." });

    // ✅ P1: plan must belong to tenant
    const planRes = await db.query(
      `
      SELECT id, included_minutes, included_uses, validity_days, is_active
      FROM membership_plans
      WHERE id=$1 AND tenant_id=$2
      LIMIT 1
      `,
      [planId, tenantId]
    );
    if (!planRes.rows.length) return res.status(404).json({ error: "Plan not found." });

    const plan = planRes.rows[0];
    if (!plan.is_active) return res.status(400).json({ error: "Plan is not active." });

    const remainingMinutes = Number(plan.included_minutes || 0);
    const remainingUses = Number(plan.included_uses || 0);
    const validityDays = Number(plan.validity_days || 30);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + validityDays);

    // Insert membership
    const insertRes = await db.query(
      `
      INSERT INTO customer_memberships
        (tenant_id, customer_id, membership_plan_id, remaining_minutes, remaining_uses, expires_at, status)
      VALUES
        ($1, $2, $3, $4, $5, $6, 'active')
      RETURNING *
      `,
      [tenantId, cid, planId, remainingMinutes, remainingUses, expiresAt.toISOString()]
    );

    const membership = insertRes.rows[0];

    // Ledger purchase (append-only)
    await db.query(
      `
      INSERT INTO membership_ledger
        (tenant_id, customer_membership_id, type, minutes_delta, uses_delta, note)
      VALUES
        ($1, $2, 'purchase', $3, $4, $5)
      `,
      [tenantId, membership.id, remainingMinutes, remainingUses, "Membership purchased"]
    );

    return res.json({ membership });
  } catch (err) {
    console.error("POST /api/customer-memberships/subscribe error:", err);
    return res.status(500).json({ error: "Failed to subscribe." });
  }
});

// GET /api/customer-memberships/:id/ledger?tenantSlug|tenantId
// P1: membership + ledger must belong to tenant
router.get("/:id/ledger", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const membershipId = Number(req.params.id);

    if (!Number.isFinite(membershipId) || membershipId <= 0) {
      return res.status(400).json({ error: "Invalid membership id." });
    }

    // ✅ P1: membership must belong to tenant
    const mRes = await db.query(
      `SELECT id FROM customer_memberships WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [membershipId, tenantId]
    );
    if (!mRes.rows.length) return res.status(404).json({ error: "Membership not found for tenant." });

    const r = await db.query(
      `
      SELECT
        id,
        created_at,
        type,
        minutes_delta,
        uses_delta,
        note,
        booking_id
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
