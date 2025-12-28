// routes/membershipPlans.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { getTenantIdFromSlug } = require("../utils/tenants");

// GET /api/membership-plans?tenantSlug=
router.get("/", async (req, res) => {
  try {
    const { tenantSlug } = req.query;
    if (!tenantSlug) return res.json({ plans: [] });

    const tenantId = await getTenantIdFromSlug(String(tenantSlug));
    if (!tenantId) return res.status(400).json({ error: "Unknown tenantSlug." });

    const q = `
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
      WHERE tenant_id = $1 AND is_active = TRUE
      ORDER BY id DESC
    `;
    const r = await pool.query(q, [tenantId]);

    return res.json({ plans: r.rows });
  } catch (err) {
    console.error("GET /api/membership-plans error:", err);
    return res.status(500).json({ error: "Failed to load membership plans." });
  }
});

module.exports = router;
