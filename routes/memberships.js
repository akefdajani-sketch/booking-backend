// routes/memberships.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { getTenantIdFromSlug } = require("../utils/tenants");

// GET /api/memberships/plans?tenantSlug=&tenantId=
// Public: shows active plans for a tenant
router.get("/plans", async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;

    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "Unknown tenant." });
    }

    // ✅ Fix: treat NULL is_active as TRUE (legacy / older rows)
    const result = await db.query(
      `
      SELECT
        id,
        tenant_id,
        name,
        validity_days,
        minutes_total,
        uses_total,
        price_jd,
        is_active,
        created_at
      FROM membership_plans
      WHERE tenant_id = $1
        AND COALESCE(is_active, TRUE) = TRUE
      ORDER BY
        price_jd NULLS LAST,
        name ASC
      `,
      [resolvedTenantId]
    );

    return res.json({ plans: result.rows });
  } catch (err) {
    console.error("Error loading membership plans:", err);
    return res.status(500).json({ error: "Failed to load membership plans" });
  }
});

// GET /api/memberships/customer?customerId=
// Returns memberships for a customer (latest first)
router.get("/customer", async (req, res) => {
  try {
    const customerId = Number(req.query.customerId);
    if (!customerId) return res.status(400).json({ error: "customerId is required" });

    const result = await db.query(
      `
      SELECT
        cm.*,
        mp.name AS plan_name,
        mp.validity_days,
        mp.minutes_total,
        mp.uses_total,
        mp.price_jd
      FROM customer_memberships cm
      JOIN membership_plans mp ON mp.id = cm.plan_id
      WHERE cm.customer_id = $1
      ORDER BY cm.created_at DESC
      `,
      [customerId]
    );

    return res.json({ customerMemberships: result.rows });
  } catch (err) {
    console.error("Error loading customer memberships:", err);
    return res.status(500).json({ error: "Failed to load customer memberships" });
  }
});

// POST /api/memberships/subscribe
// Body: { customerId, planId }
// ✅ Includes failsafe: block if current membership is active AND has remaining balance
router.post("/subscribe", requireGoogleAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customerId, planId } = req.body || {};
    const cid = Number(customerId);
    const pid = Number(planId);

    if (!cid || !pid) {
      return res.status(400).json({ error: "customerId and planId are required" });
    }

    await client.query("BEGIN");

    // Load customer (used to tenant-check)
    const custRes = await client.query(
      `SELECT id, tenant_id FROM customers WHERE id = $1 LIMIT 1`,
      [cid]
    );
    if (!custRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid customerId" });
    }
    const customerTenantId = Number(custRes.rows[0].tenant_id);

    // Lock current memberships for this customer
    const currentRes = await client.query(
      `
      SELECT *
      FROM customer_memberships
      WHERE customer_id = $1
      ORDER BY created_at DESC
      FOR UPDATE
      `,
      [cid]
    );

    const now = new Date();
    const current = currentRes.rows.find((m) => {
      const statusOk = String(m.status || "").toLowerCase() === "active";
      const endOk = !m.end_at || new Date(m.end_at).getTime() >= now.getTime();
      return statusOk && endOk;
    });

    if (current) {
      const mins = Number(current.minutes_remaining || 0);
      const uses = Number(current.uses_remaining || 0);

      // ❌ FAILSAFE: block renew if still active AND has balance
      if (mins > 0 || uses > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "You already have an active plan with remaining balance. You can renew once it expires or your balance runs out.",
        });
      }
    }

    // Load plan (must be active-ish) and must belong to same tenant as customer
    const planRes = await client.query(
      `
      SELECT *
      FROM membership_plans
      WHERE id = $1
        AND COALESCE(is_active, TRUE) = TRUE
      LIMIT 1
      `,
      [pid]
    );

    if (!planRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid planId" });
    }

    const plan = planRes.rows[0];
    const planTenantId = Number(plan.tenant_id);

    if (customerTenantId && planTenantId && customerTenantId !== planTenantId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Plan does not belong to this tenant." });
    }

    const validityDays = Number(plan.validity_days || 0);
    const minutesTotal = Number(plan.minutes_total || 0);
    const usesTotal = Number(plan.uses_total || 0);

    // Expire any active memberships (best practice)
    await client.query(
      `
      UPDATE customer_memberships
      SET status = 'expired', end_at = NOW()
      WHERE customer_id = $1 AND status = 'active'
      `,
      [cid]
    );

    // Create new membership
    const startAt = new Date();
    const endAt =
      validityDays > 0
        ? new Date(startAt.getTime() + validityDays * 24 * 60 * 60 * 1000)
        : null;

    const insertRes = await client.query(
      `
      INSERT INTO customer_memberships
        (customer_id, plan_id, status, start_at, end_at, minutes_remaining, uses_remaining, created_at)
      VALUES
        ($1, $2, 'active', $3, $4, $5, $6, NOW())
      RETURNING *
      `,
      [
        cid,
        pid,
        startAt.toISOString(),
        endAt ? endAt.toISOString() : null,
        minutesTotal,
        usesTotal,
      ]
    );

    await client.query("COMMIT");
    return res.json({ membership: insertRes.rows[0] });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("Error subscribing membership:", err);
    return res.status(500).json({ error: "Failed to subscribe membership" });
  } finally {
    client.release();
  }
});

module.exports = router;
