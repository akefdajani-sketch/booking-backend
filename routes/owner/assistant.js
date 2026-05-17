'use strict';

// routes/owner/assistant.js
//
// Flexrz Assistant — owner-side AI agent for tenant analytics.
//
// Endpoint:
//   POST /api/owner/assistant/:tenantSlug/chat
//
// Body:
//   { message: string, history?: Array<{role,content}> }
//
// Auth:
//   requireTenant (slug copied from path → query) + requireAdminOrTenantRole('owner')
//
// Why this exists:
//   The Flexrz Assistant in booking-frontend was previously calling
//   https://api.anthropic.com/v1/messages directly from the browser. CSP
//   blocked the request in production, and even if it hadn't, the API
//   key would have been exposed in the bundle. This route proxies the
//   call server-side using ANTHROPIC_API_KEY from env.
//
// Scope (v1):
//   Owner analytics queries only (today's bookings, revenue, utilization,
//   etc.) — NOT booking creation. Booking creation lives in the
//   brain+persona orchestrator on the customer-side path, which is
//   intentionally NOT imported here (Phase 2 protected files).

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const { requireTenant } = require("../../middleware/requireTenant");
const { getTenantBySlug } = require("../../utils/tenants");
const { getDashboardSummary } = require("../../utils/dashboardSummary");
const logger = require("../../utils/logger");

const router = express.Router();

// Single module-level client. Anthropic() reads ANTHROPIC_API_KEY from env.
const claude = new Anthropic();

// Inline middleware: copy :tenantSlug param into query so requireTenant
// picks it up the same way it does for body/query callers. Mirrors the
// pattern in routes/tenantDashboard.js.
function tenantSlugFromParam(req, _res, next) {
  req.query = req.query || {};
  if (req.params.tenantSlug && !req.query.tenantSlug) {
    req.query.tenantSlug = req.params.tenantSlug;
  }
  next();
}

function todayInTenantTz(tenantTz) {
  // YYYY-MM-DD in the tenant's local timezone (Render runs UTC).
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: tenantTz || "UTC" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function buildOwnerAssistantPrompt(tenant, summary) {
  const tz = tenant.timezone || "Asia/Amman";
  const nowStr = new Date().toLocaleString("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "short" });

  // Pull a compact subset of the summary for the prompt. Avoids dumping
  // the entire panels+series+drilldowns payload (token waste).
  const k = summary?.kpis || {};
  const util = summary?.utilization?.overall || {};
  const next = summary?.panels?.nextBookings || [];
  const alerts = summary?.panels?.alerts || [];
  const insights = summary?.panels?.insights || [];
  const range = summary?.range || {};
  const currency = summary?.currency_code || "JD";

  const nextBookingsBlock = next.length > 0
    ? next.slice(0, 10).map(b => {
        const t = b.start_time ? new Date(b.start_time).toLocaleString("en-GB", { timeZone: tz, dateStyle: "short", timeStyle: "short" }) : "?";
        return `  - ${t} | ${b.service_name || "Service"} | ${b.customer_name || "Customer"} | status: ${b.status || "?"}`;
      }).join("\n")
    : "  None scheduled.";

  const alertsBlock = alerts.length > 0
    ? alerts.slice(0, 10).map(a => `  - ${a.title || a.message || JSON.stringify(a)}`).join("\n")
    : "  None.";

  const insightsBlock = insights.length > 0
    ? insights.slice(0, 10).map(i => `  - ${i.title || i.message || JSON.stringify(i)}`).join("\n")
    : "  None.";

  return `You are the Flexrz Assistant for ${tenant.name}.
You help the OWNER understand their business — analytics, bookings, revenue,
utilization, staff, customers. You do NOT create or modify bookings (that's
the customer-side agent).

BUSINESS: ${tenant.name} (slug: ${tenant.slug}, timezone: ${tz})
CURRENT TIME: ${nowStr}

TODAY'S SNAPSHOT (range: ${range.from || "?"} → ${range.to || "?"}):
  Bookings confirmed: ${k.bookings ?? 0}
  Bookings pending:   ${k.pending ?? 0}
  Bookings cancelled: ${k.cancelled ?? 0}
  Revenue:            ${k.revenue_amount != null ? `${k.revenue_amount} ${currency}` : "0"}
  Utilization:        ${k.utilizationPct != null ? `${k.utilizationPct}%` : "n/a"}
  Repeat rate:        ${k.repeatPct != null ? `${k.repeatPct}%` : "n/a"}
  Active memberships: ${k.activeMemberships ?? 0}
  No-show rate:       ${k.noShowRate != null ? `${k.noShowRate}%` : "n/a"}
  Booked minutes:     ${util.booked_minutes ?? 0} / ${util.available_minutes ?? 0} available

NEXT BOOKINGS (next 5–10):
${nextBookingsBlock}

ALERTS:
${alertsBlock}

INSIGHTS:
${insightsBlock}

RULES:
- Answer ONLY from the data above. If the answer isn't in the snapshot, say so
  honestly and tell the owner where to look in the dashboard.
- Be concise: 1–3 sentences for simple questions, short bullets for lists.
- Speak naturally about money — "47 dinars" not "47.00 JD". Match the
  language the owner is using.
- Never reveal customer PII beyond what already appears in the snapshot
  (names + booking times are fine; emails, phones, payment details are not).
- Never invent figures. If a metric reads "n/a", say "not available for
  today's range" rather than guessing.`;
}

router.post(
  "/:tenantSlug/chat",
  tenantSlugFromParam,
  requireTenant,
  requireAdminOrTenantRole("owner"),
  async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message required" });
      }

      const tenantSlug = String(req.params.tenantSlug || "").trim();
      let tenant;
      try {
        tenant = await getTenantBySlug(tenantSlug);
      } catch (err) {
        if (err?.code === "TENANT_NOT_FOUND") {
          return res.status(404).json({ error: "Tenant not found" });
        }
        throw err;
      }

      // Today's structured analytics for the system prompt.
      const dateStr = todayInTenantTz(tenant.timezone);
      let summary = {};
      try {
        summary = await getDashboardSummary({
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          mode: "day",
          dateStr,
        });
      } catch (err) {
        // Don't fail the chat if analytics aggregation hiccups — fall back
        // to an empty snapshot so the assistant can still answer general
        // questions like "what does utilization rate mean?".
        logger.warn({ err, tenantSlug }, "owner assistant: getDashboardSummary failed");
      }

      const systemPrompt = buildOwnerAssistantPrompt(tenant, summary);

      const safeHistory = Array.isArray(history)
        ? history
            .filter(m => m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
            .slice(-20) // cap to last 20 turns to keep prompt size bounded
        : [];

      const response = await claude.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        temperature: 0.3,
        system: systemPrompt,
        messages: [
          ...safeHistory,
          { role: "user", content: message },
        ],
      });

      const reply = (response?.content || [])
        .filter(c => c?.type === "text" && typeof c.text === "string")
        .map(c => c.text)
        .join("\n")
        .trim();

      return res.json({ reply, actionTaken: null });
    } catch (err) {
      logger.error({ err, tenantSlug: req.params.tenantSlug }, "owner assistant chat failed");
      return res.status(500).json({ error: "AI assistant unavailable" });
    }
  }
);

module.exports = router;
