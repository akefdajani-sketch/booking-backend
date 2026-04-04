import express from "express";
import { runSupportAgent, generateLandingCopy } from "../utils/claudeService.js";

// ── Replace these imports with your actual middleware/query helpers ───
// import { requireAuth } from "../middleware/auth.js";
// import { getTenantBySlug } from "../queries/tenants.js";
// import { getServicesByTenant } from "../queries/services.js";
// import { getMembershipsByTenant } from "../queries/memberships.js";

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

    // ── swap these for your real DB helpers ──────────────────────────
    const tenant = await getTenantBySlug(req.params.tenantSlug);
    if (!tenant) return res.status(404).json({ error: "tenant not found" });

    const services = await getServicesByTenant(tenant.id);
    const memberships = await getMembershipsByTenant(tenant.id);
    // ─────────────────────────────────────────────────────────────────

    const reply = await runSupportAgent({
      tenantContext: { ...tenant, services, memberships },
      history,
      message,
    });

    res.json({ reply });
  } catch (err) {
    console.error("[AI chat error]", err);
    res.status(500).json({ error: "AI unavailable, please try again" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/:tenantSlug/generate-landing
// Private — owner only, called from the dashboard
// Body: {} (no body needed, data is pulled from DB)
// ---------------------------------------------------------------------------
router.post("/:tenantSlug/generate-landing", /* requireAuth, */ async (req, res) => {
  try {
    // ── swap these for your real DB helpers ──────────────────────────
    const tenant = await getTenantBySlug(req.params.tenantSlug);
    if (!tenant) return res.status(404).json({ error: "tenant not found" });

    const services = await getServicesByTenant(tenant.id);
    const memberships = await getMembershipsByTenant(tenant.id);
    // ─────────────────────────────────────────────────────────────────

    const copy = await generateLandingCopy({ tenant, services, memberships });

    res.json(copy);
  } catch (err) {
    console.error("[Landing gen error]", err);
    res.status(500).json({ error: "Generation failed, please try again" });
  }
});

export default router;
