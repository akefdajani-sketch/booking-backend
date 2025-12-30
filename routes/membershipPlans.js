// routes/membershipPlans.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const { requireTenant } = require("../middleware/requireTenant");

// GET /api/membership-plans?tenantSlug|tenantId=
// Public read, tenant-scoped (P1)
router.get("/", requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;

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
      ORDER BY created_at DESC
      `,
      [tenantId]
    );

    return res.json({ plans: result.rows });
  } catch (err) {
    console.error("GET /api/membership-plans error:", err);
    return res.status(500).json({ error: "Failed to load membership plans." });
  }
});

module.exports = router;
