"use strict";

// routes/voice.js
// ────────────────────────────────────────────────────────────────────────────
// VOICE-2: ElevenLabs Conversational AI integration for the public booking
// assistant.
//
// ARCHITECTURE:
//   1. Browser hits POST /api/voice/:tenantSlug/session
//      → server fetches business + customer context, builds a system prompt
//        override, requests a short-lived ElevenLabs token, returns it.
//   2. Browser uses @elevenlabs/client SDK to open WebRTC/WebSocket session.
//   3. ElevenLabs runs the agent (STT → LLM → TTS) and streams audio
//      bidirectionally with the browser. Sub-second turn latency.
//   4. When the agent invokes the ask_booking_assistant clientTool, the
//      browser POSTs to /api/voice/:tenantSlug/booking-assistant with the
//      query + history. Server runs the existing runSupportAgent + handleAction
//      pipeline (the SAME brain the text chat uses) and returns the result.
//   5. The agent speaks the result, conversation continues.
//   6. On end, browser POSTs to /api/voice/:tenantSlug/session/end (telemetry).
//
// WHY THIS SHAPE:
// - ElevenLabs API key never touches the browser.
// - Per-tenant context gets baked into the agent's prompt ONCE per session,
//   not per turn. ~10x fewer DB queries vs the chat path.
// - The booking-assistant tool reuses runSupportAgent + handleAction without
//   any duplication. Voice and text produce identical booking results.
// - The agent's base prompt + voice + LLM choice live in the ElevenLabs
//   dashboard. We pass per-session prompt overrides via overrides.agent.prompt.
//
// CONFIG (env vars):
//   ELEVENLABS_API_KEY     — server-side API key with Conversational AI scope
//   ELEVENLABS_AGENT_ID    — the agent to run (single Flexrz-wide agent)
//   FRONTEND_URL           — used in CORS / not directly needed here
// ────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router  = express.Router();

const { getTenantBySlug } = require("../utils/tenants");
const { runSupportAgent } = require("../utils/claudeService");
const { buildVoiceSystemPromptOverride } = require("../utils/voiceContext");

// Helpers re-exported by routes/ai.js — same brain, same DB queries.
const aiRoutes = require("./ai");
const fetchBusinessContext  = aiRoutes.fetchBusinessContext;
const fetchCustomerData     = aiRoutes.fetchCustomerData;
const handleAction          = aiRoutes.handleAction;
const isConfirmationMessage = aiRoutes.isConfirmationMessage;
const optionalAuth          = aiRoutes.optionalAuth;

const VOICE_MAX_SESSION_SECONDS = 30 * 60; // 30-min hard cap per call

// ────────────────────────────────────────────────────────────────────────────
// POST /api/voice/:tenantSlug/session
// Body: { authToken? }
// Query: ?type=webrtc | websocket  (mobile prefers websocket)
// Returns: { connection_type, conversation_token | signed_url, agent_id,
//            prompt_override, max_session_seconds, customer_first_name }
// ────────────────────────────────────────────────────────────────────────────
router.post("/:tenantSlug/session", optionalAuth, async (req, res) => {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;

  if (!apiKey || !agentId) {
    return res.status(503).json({
      error: "voice_not_configured",
      detail: "ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must be set on the server",
    });
  }

  try {
    const tenant = await getTenantBySlug(req.params.tenantSlug);
    if (!tenant) return res.status(404).json({ error: "tenant_not_found" });

    const email      = req.auth?.email || req.googleUser?.email || null;
    const isSignedIn = !!email;

    // Load business + customer context. Same shape the text chat uses.
    const [businessContext, customerData] = await Promise.all([
      fetchBusinessContext(tenant.id, tenant.slug),
      isSignedIn ? fetchCustomerData(tenant.id, email) : Promise.resolve(null),
    ]);

    // Build the per-session prompt override. The agent's BASE prompt (in EL
    // dashboard) should say something like: "You are a booking concierge. Use
    // ask_booking_assistant for any availability/booking/cancellation work."
    // The override prepends business + customer context + voice rules.
    const promptOverride = buildVoiceSystemPromptOverride({
      tenant, businessContext, customerData, isSignedIn,
    });

    // Connection type — desktop gets WebRTC (low latency, good audio), mobile
    // gets WebSocket (TCP-only, more reliable on cellular & restrictive WiFi).
    const requestedType = req.query.type === "websocket" ? "websocket" : "webrtc";

    let elUrl, tokenField, clientField;
    if (requestedType === "webrtc") {
      elUrl = `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`;
      tokenField  = "token";
      clientField = "conversation_token";
    } else {
      elUrl = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
      tokenField  = "signed_url";
      clientField = "signed_url";
    }

    const r = await fetch(elUrl, {
      method: "GET",
      headers: { "xi-api-key": apiKey },
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error(`[voice] ElevenLabs ${requestedType} mint failed:`, r.status, errText.slice(0, 300));
      // 401 → bad key, 403 → key lacks ConvAI scope, 404 → wrong agent_id,
      // 422 → auth not enabled on agent.
      return res.status(502).json({
        error: "elevenlabs_token_failed",
        status: r.status,
        detail: errText.slice(0, 300),
      });
    }

    const body = await r.json();
    const tokenValue = body[tokenField] || body.token || body.conversation_token || body.signed_url;
    if (!tokenValue) {
      console.error("[voice] ElevenLabs returned no token field:", Object.keys(body));
      return res.status(502).json({ error: "elevenlabs_no_token", detail: Object.keys(body).join(",") });
    }

    // First-name greeting for the agent's first message override.
    const firstName = customerData?.profile?.name
      ? customerData.profile.name.split(" ")[0]
      : null;

    const out = {
      connection_type: requestedType,
      agent_id: agentId,
      prompt_override: promptOverride,
      first_message_override: firstName
        ? `Hi ${firstName}! I have your account open. How can I help — book something, check your balance, anything?`
        : `Hi! I'm the booking assistant for ${tenant.name}. What can I help with?`,
      max_session_seconds: VOICE_MAX_SESSION_SECONDS,
      customer_first_name: firstName,
      tenant_name: tenant.name,
      is_signed_in: isSignedIn,
    };
    out[clientField] = tokenValue;

    console.log(`[voice] session opened: tenant=${tenant.slug} signedIn=${isSignedIn} type=${requestedType}`);
    res.json(out);
  } catch (err) {
    console.error("[voice] session error:", err.message);
    res.status(500).json({ error: err.message || "voice_session_failed" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/voice/:tenantSlug/booking-assistant
// The bridge tool the ElevenLabs agent calls.
// Body: { query, history, pendingAction? }
// Returns: { reply, action, pendingBooking, slots }
//
// This is essentially the same handler as routes/ai.js POST /:slug/chat,
// minus the "is this confirmation?" duplication. The voice agent already
// understands when the customer is confirming, so we pass that through as a
// flag instead of guessing from the message text.
// ────────────────────────────────────────────────────────────────────────────
router.post("/:tenantSlug/booking-assistant", optionalAuth, async (req, res) => {
  try {
    const { query, history = [], pendingAction, isConfirming } = req.body || {};

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "query is required" });
    }
    if (query.length > 4000) {
      return res.status(400).json({ error: "query too long (max 4000 chars)" });
    }

    const tenant = await getTenantBySlug(req.params.tenantSlug);
    if (!tenant) return res.status(404).json({ error: "tenant_not_found" });

    const email      = req.auth?.email || req.googleUser?.email || null;
    const isSignedIn = !!email;

    // Auth token for booking actions
    const authToken = req.headers.authorization?.replace("Bearer ", "")
      || req.cookies?.bf_session || null;

    const customerData = isSignedIn ? await fetchCustomerData(tenant.id, email) : null;

    // ── DIRECT BOOKING via pendingAction (same fast path as text chat) ────
    if (pendingAction?.type === "create_booking" && pendingAction?.service_id && pendingAction?.start_time) {
      console.log("[voice] pendingAction direct-execute:", JSON.stringify(pendingAction));
      const directResult = await handleAction(
        pendingAction, tenant.id, tenant.slug,
        customerData?.profile?.id || null, email, authToken
      );
      const directReply = directResult?.success && directResult?.bookingId
        ? (directResult.message || "Booking confirmed!")
        : (directResult?.message || "Something went wrong creating the booking. Please try via the booking form.");
      return res.json({
        reply: directReply,
        action: directResult,
        pendingBooking: null,
        slots: directResult?.slots || null,
      });
    }

    // ── Run Claude (same brain as text chat) ──────────────────────────────
    // We load business context here too, but only for the SECOND turn onwards
    // (Claude needs it to interpret service IDs in availability results).
    // The agent's session prompt already has it for context — this is for
    // Claude's runSupportAgent call.
    const businessContext = await fetchBusinessContext(tenant.id, tenant.slug);

    // The voice agent passes isConfirming=true when the user said "yes" /
    // "confirm" to a pending booking. If absent, fall back to the text-side
    // detector for safety.
    const confirmationMode = (typeof isConfirming === "boolean")
      ? isConfirming
      : isConfirmationMessage(query);

    const { reply, action } = await runSupportAgent({
      tenantContext: { ...tenant, ...businessContext },
      customerData,
      isSignedIn,
      history,
      message: query,
      confirmationMode,
    });

    // ── Execute action if Claude requested one ───────────────────────────
    let actionResult = null;
    let finalReply   = reply || "";

    if (action) {
      actionResult = await handleAction(
        action, tenant.id, tenant.slug,
        customerData?.profile?.id || null, email, authToken
      );

      // If the action was check_availability, follow up so Claude phrases the
      // result naturally instead of dumping raw slot times. Same two-pass
      // pattern as routes/ai.js.
      if (action.type === "check_availability" && actionResult) {
        let actionContext = "";
        if (actionResult.success && actionResult.slots && actionResult.slots.length > 0) {
          const slotTimes = actionResult.slots.map(s => s.time || s.label).filter(Boolean).slice(0, 12).join(", ");
          actionContext = `AVAILABILITY RESULT: Found ${actionResult.slots.length} available slots on ${action.date}: ${slotTimes}. resource_id=${actionResult.resourceId || action.resource_id || "auto"}.`;
        } else if (actionResult.success) {
          actionContext = `AVAILABILITY RESULT: ${actionResult.message || `No available slots on ${action.date}.`}`;
        } else {
          actionContext = `AVAILABILITY RESULT: Failed — ${actionResult.message}`;
        }

        try {
          const followUp = await runSupportAgent({
            tenantContext: { ...tenant, ...businessContext },
            customerData,
            isSignedIn,
            history: [
              ...history,
              { role: "user", content: query },
              ...(reply ? [{ role: "assistant", content: reply }] : []),
              { role: "user", content: `[SYSTEM: ${actionContext}]` },
            ],
            message: actionContext,
          });
          if (followUp.reply) finalReply = followUp.reply;
        } catch (e) {
          console.error("[voice] follow-up error:", e.message);
          if (actionResult.message) finalReply = actionResult.message;
        }
      }

      // For successful create_booking — use the pre-formatted message
      if (action.type === "create_booking" && actionResult?.success) {
        finalReply = actionResult.message || "Booked! Confirmation sent.";
      }
      if (action.type === "create_booking" && actionResult?.requiresUI) {
        finalReply = actionResult.message;
      }
    }

    if (!finalReply || !finalReply.trim()) {
      finalReply = actionResult?.message || "I processed your request. Anything else?";
    }

    // Strip any PENDING_BOOKING line embedded by Claude — voice surfaces this
    // as a rich card on the client, but the spoken text shouldn't include the
    // raw JSON.
    let pendingBooking = null;
    const pbMatch = finalReply.match(/^PENDING_BOOKING:(\{[^\n\r]+\})\s*$/m);
    if (pbMatch) {
      try {
        pendingBooking = JSON.parse(pbMatch[1]);
        finalReply = finalReply.replace(/^PENDING_BOOKING:\{[^\n\r]+\}\s*$/m, "").trim();
      } catch (e) {
        console.error("[voice] PENDING_BOOKING parse error:", e.message);
      }
    }

    res.json({
      reply: finalReply,
      action: actionResult,
      pendingBooking,
      slots: actionResult?.slots || null,
    });
  } catch (err) {
    console.error("[voice] booking-assistant error:", err);
    res.status(500).json({ error: err.message || "booking_assistant_failed" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/voice/:tenantSlug/session/end
// Body: { seconds_used }
// Telemetry only — actual ElevenLabs billing happens on their side.
// We log the duration so we can keep eyes on per-tenant voice usage.
// ────────────────────────────────────────────────────────────────────────────
router.post("/:tenantSlug/session/end", optionalAuth, async (req, res) => {
  try {
    const seconds = parseInt(req.body?.seconds_used, 10);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > VOICE_MAX_SESSION_SECONDS + 60) {
      return res.status(400).json({ error: "invalid seconds_used" });
    }
    console.log(`[voice] session ended: tenant=${req.params.tenantSlug} duration=${seconds}s`);
    res.json({ ok: true, seconds_used: seconds });
  } catch (err) {
    console.error("[voice] session/end error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/voice/:tenantSlug/session/event
// Diagnostic telemetry from the browser — connect, disconnect, errors,
// finish_session calls. Helps debug "voice silently went idle" cases.
// Best-effort. Always 200.
// ────────────────────────────────────────────────────────────────────────────
router.post("/:tenantSlug/session/event", async (req, res) => {
  try {
    const event  = String(req.body?.event || "").slice(0, 64);
    const detail = (req.body?.detail && typeof req.body.detail === "object") ? req.body.detail : {};
    if (!event) return res.json({ ok: true });
    let detailJson = "";
    try {
      detailJson = JSON.stringify(detail);
      if (detailJson.length > 1024) detailJson = detailJson.slice(0, 1024) + "…";
    } catch { detailJson = "{}"; }
    console.log(`[voice] tenant=${req.params.tenantSlug} event=${event} ${detailJson}`);
    res.json({ ok: true });
  } catch (e) {
    try { console.warn("[voice] telemetry swallow:", e.message); } catch {}
    res.json({ ok: true });
  }
});

module.exports = router;
