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

    const [servicesResult, membershipsResult] = await Promise.all([
      db.query(
        `SELECT id, name, duration_minutes, price FROM services
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY name ASC`,
        [tenant.id]
      ),
      db.query(
        `SELECT id, name FROM membership_plans
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY name ASC`,
        [tenant.id]
      ),
    ]);

    const reply = await runSupportAgent({
      tenantContext: {
        ...tenant,
        services: servicesResult.rows,
        memberships: membershipsResult.rows,
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
        `SELECT id, name, duration_minutes, price FROM services
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY name ASC`,
        [tenant.id]
      ),
      db.query(
        `SELECT id, name FROM membership_plans
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
