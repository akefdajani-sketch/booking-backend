"use strict";

const express = require("express");
const db = require("../db");
const { getTenantBySlug } = require("../utils/tenants");
const { runSupportAgent, generateLandingCopy } = require("../utils/claudeService");

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/ai/:tenantSlug/chat
// Public — used by customers on the booking page
// Body: { message: string, history: Array<{ role, content }> }
// ---------------------------------------------------------------------------
router.post("/:tenantSlug/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    const tenant = await getTenantBySlug(req.params.tenantSlug);

    const [servicesResult, membershipsResult, ratesResult] = await Promise.all([
      db.query(
        `SELECT id, name, description, duration_minutes, price_amount AS price,
                max_consecutive_slots, max_parallel_bookings, slot_interval_minutes
         FROM services
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY name ASC`,
        [tenant.id]
      ),
      db.query(
        `SELECT id, name, description, billing_type, price, currency,
                included_minutes, included_uses, validity_days
         FROM membership_plans
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY name ASC`,
        [tenant.id]
      ),
      db.query(
        `SELECT r.name, r.price_type, r.amount, r.currency_code,
                r.days_of_week, r.time_start, r.time_end,
                r.date_start, r.date_end, r.min_duration_mins, r.max_duration_mins,
                r.require_any_membership, r.require_any_prepaid,
                s.name AS service_name, mp.name AS membership_name
         FROM rate_rules r
         LEFT JOIN services s ON s.id = r.service_id
         LEFT JOIN membership_plans mp ON mp.id = r.membership_plan_id
         WHERE r.tenant_id = $1 AND COALESCE(r.is_active, false) = true
         ORDER BY r.priority DESC NULLS LAST, r.name ASC`,
        [tenant.id]
      ),
    ]);

    const reply = await runSupportAgent({
      tenantContext: {
        ...tenant,
        services: servicesResult.rows,
        memberships: membershipsResult.rows,
        rates: ratesResult.rows,
      },
      history,
      message,
    });

    res.json({ reply });
  } catch (err) {
    if (err.code === "TENANT_NOT_FOUND") {
      return res.status(404).json({ error: "Tenant not found" });
    }
    console.error("[AI chat error]", err);
    res.status(500).json({ error: "AI unavailable, please try again" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/:tenantSlug/generate-landing
// Private — owner only, called from the dashboard
// Body: {} (data is pulled from DB automatically)
// ---------------------------------------------------------------------------
router.post("/:tenantSlug/generate-landing", async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.tenantSlug);

    const [servicesResult, membershipsResult] = await Promise.all([
      db.query(
        `SELECT id, name, description, duration_minutes, price_amount AS price,
                max_consecutive_slots, max_parallel_bookings, slot_interval_minutes
         FROM services
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY name ASC`,
        [tenant.id]
      ),
      db.query(
        `SELECT id, name, description, billing_type, price, currency,
                included_minutes, included_uses, validity_days
         FROM membership_plans
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY name ASC`,
        [tenant.id]
      ),
    ]);

    const copy = await generateLandingCopy({
      tenant,
      services: servicesResult.rows,
      memberships: membershipsResult.rows,
    });

    res.json(copy);
  } catch (err) {
    if (err.code === "TENANT_NOT_FOUND") {
      return res.status(404).json({ error: "Tenant not found" });
    }
    console.error("[Landing gen error]", err);
    res.status(500).json({ error: "Generation failed, please try again" });
  }
});

module.exports = router;
