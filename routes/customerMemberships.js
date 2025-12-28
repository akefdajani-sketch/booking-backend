// routes/customerMemberships.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { getTenantIdFromSlug } = require("../utils/tenants");

// GET /api/customer-memberships?tenantSlug=&customerId=
router.get("/", async (req, res) => {
  try {
    const { tenantSlug, customerId } = req.query;

    if (!tenantSlug || !customerId) return res.json({ memberships: [] });

    const tenantId = await getTenantIdFromSlug(String(tenantSlug));
    if (!tenantId) return res.status(400).json({ error: "Unknown tenantSlug." });

    const cid = Number(customerId);
    if (!Number.isFinite(cid)) return res.json({ memberships: [] });

    const q = `
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
        mp.validity_days AS plan_validity_days
      FROM customer_memberships cm
      JOIN membership_plans mp ON mp.id = cm.membership_plan_id
      WHERE cm.tenant_id = $1 AND cm.customer_id = $2
      ORDER BY cm.created_at DESC
    `;
    const r = await pool.query(q, [tenantId, cid]);

    return res.json({ memberships: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships error:", err);
    return res.status(500).json({ error: "Failed to load memberships." });
  }
});

// POST /api/customer-memberships/subscribe
router.post("/subscribe", async (req, res) => {
  try {
    const { tenantSlug, customerId, membershipPlanId } = req.body;

    if (!tenantSlug || !customerId || !membershipPlanId) {
      return res.status(400).json({ error: "Missing tenantSlug/customerId/membershipPlanId." });
    }

    const tenantId = await getTenantIdFromSlug(String(tenantSlug));
    if (!tenantId) return res.status(400).json({ error: "Unknown tenantSlug." });

    const cid = Number(customerId);
    const planId = Number(membershipPlanId);
    if (!Number.isFinite(cid) || !Number.isFinite(planId)) {
      return res.status(400).json({ error: "Invalid ids." });
    }

    // Load plan
    const planRes = await pool.query(
      `
      SELECT
        id, included_minutes, included_uses, validity_days, is_active
      FROM membership_plans
      WHERE id = $1 AND tenant_id = $2
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

    // Create membership
    const insertRes = await pool.query(
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

    // Ledger: "purchase"
    await pool.query(
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

// GET /api/customer-memberships/:id/ledger?tenantSlug=
router.get("/:id/ledger", async (req, res) => {
  try {
    const { tenantSlug } = req.query;
    const { id } = req.params;

    if (!tenantSlug) return res.status(400).json({ error: "tenantSlug is required." });

    const membershipId = Number(id);
    if (!Number.isFinite(membershipId)) return res.status(400).json({ error: "Invalid membership id." });

    const tenantId = await getTenantIdFromSlug(String(tenantSlug));
    if (!tenantId) return res.status(400).json({ error: "Unknown tenantSlug." });

    // Ensure membership belongs to tenant
    const mRes = await pool.query(
      "SELECT id FROM customer_memberships WHERE id = $1 AND tenant_id = $2",
      [membershipId, tenantId]
    );
    if (mRes.rows.length === 0) {
      return res.status(404).json({ error: "Membership not found for tenant." });
    }

    const q = `
      SELECT
        id,
        created_at,
        type,
        minutes_delta,
        uses_delta,
        note,
        booking_id
      FROM membership_ledger
      WHERE tenant_id = $1 AND customer_membership_id = $2
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const r = await pool.query(q, [tenantId, membershipId]);

    return res.json({ ledger: r.rows });
  } catch (err) {
    console.error("GET /api/customer-memberships/:id/ledger error:", err);
    return res.status(500).json({ error: "Failed to load ledger." });
  }
});

module.exports = router;
