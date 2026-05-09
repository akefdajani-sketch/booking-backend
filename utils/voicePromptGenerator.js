"use strict";

/**
 * VOICE-FIX-6 — Per-tenant voice prompt generator
 *
 * Generates a tenant-specific system prompt for the ElevenLabs ConvAI agent
 * by feeding the tenant's full DB context to Claude with a meta-prompt.
 *
 * Inputs:
 *   - tenantId (number)        — must exist in tenants
 *   - opts.dbClient (optional) — pg client to use; defaults to module's db
 *   - opts.modelOverride (optional) — Claude model id; defaults to env or 'claude-sonnet-4-6'
 *   - opts.dryRun (default false) — if true, returns the snapshot without writing it
 *
 * Output (snapshot shape stored in tenants.voice_prompt_snapshot):
 *   {
 *     prompt: "<full system prompt>",
 *     generated_at: "<ISO timestamp>",
 *     model: "<claude model id>",
 *     source_data_hash: "<sha256 of input businessContext>",
 *     version: 1
 *   }
 *
 * Architectural notes:
 *   - This module owns the META-PROMPT (the prompt-that-generates-the-prompt).
 *     The meta-prompt is the only piece of business logic that ships in code
 *     once we go fully per-tenant. Everything else lives in the tenant DB row.
 *   - The generator reads the tenant's branding, voice_instructions, services,
 *     rates, hours, resources, staff, memberships, packages — same shape as
 *     fetchBusinessContext used by the chat path.
 *   - The output is INSTRUCTIONS + REFERENCE DATA, not dynamic state. The
 *     dynamic block (current customer, today's date, language lock instructions)
 *     gets appended at session start by voiceContext.js — those change per
 *     session and shouldn't be baked into the snapshot.
 */

const Anthropic = require("@anthropic-ai/sdk");
const crypto = require("crypto");
const db = require("../db");

const claude = new Anthropic();

const DEFAULT_MODEL = process.env.CLAUDE_MODEL_VOICE_GEN
  || process.env.CLAUDE_MODEL
  || "claude-sonnet-4-6";

const SNAPSHOT_VERSION = 1;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Generate a voice prompt for one tenant and (unless dryRun) save it.
 * @param {number} tenantId
 * @param {{ dbClient?, modelOverride?, dryRun? }} [opts]
 * @returns {Promise<{ snapshot: object, raw: string }>}
 */
async function generateVoicePromptForTenant(tenantId, opts = {}) {
  const { dbClient = db, modelOverride, dryRun = false } = opts;
  const model = modelOverride || DEFAULT_MODEL;

  // Pull all the data we need. We re-use fetchBusinessContext from the AI
  // route module — same shape the chat path uses, so the generated prompt
  // will reference services/resources/staff with the same IDs Claude already
  // knows about.
  const aiRoutes = require("../routes/ai");
  const businessContext = await aiRoutes.fetchBusinessContext(tenantId, null);

  // Pull the tenant row for name, slug, timezone, currency, branding, voice_instructions
  const tenantRes = await dbClient.query(
    `SELECT id, slug, name, timezone, voice_instructions, branding
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );
  if (!tenantRes.rows[0]) {
    const err = new Error(`tenant not found: ${tenantId}`);
    err.code = "TENANT_NOT_FOUND";
    throw err;
  }
  const tenant = tenantRes.rows[0];

  // Build the meta-prompt input — a structured text block describing the
  // tenant. We use a reduced, generation-friendly summary rather than dumping
  // the raw context: Claude works better when the input is purposeful.
  const tenantSummary = buildTenantSummaryForGenerator(tenant, businessContext);

  // Hash the inputs so we can detect "no change" later if the owner clicks
  // regenerate but nothing in the DB changed.
  const sourceDataHash = crypto
    .createHash("sha256")
    .update(tenantSummary)
    .digest("hex");

  // Run the meta-prompt
  const metaPrompt = buildMetaPrompt({ tenant, tenantSummary });
  const completion = await claude.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: "user", content: metaPrompt }],
  });
  const generatedText = (completion.content || [])
    .map(b => b.type === "text" ? b.text : "")
    .join("")
    .trim();

  if (!generatedText || generatedText.length < 200) {
    const err = new Error("generator returned an unexpectedly short prompt");
    err.code = "GENERATOR_OUTPUT_TOO_SHORT";
    err.detail = { length: generatedText.length, head: generatedText.slice(0, 120) };
    throw err;
  }

  const snapshot = {
    prompt: generatedText,
    generated_at: new Date().toISOString(),
    model,
    source_data_hash: sourceDataHash,
    version: SNAPSHOT_VERSION,
  };

  if (!dryRun) {
    await dbClient.query(
      `UPDATE tenants
          SET voice_prompt_snapshot = $1::jsonb
        WHERE id = $2`,
      [JSON.stringify(snapshot), tenantId]
    );
  }

  return { snapshot, raw: generatedText };
}

/**
 * Read the current snapshot for a tenant.
 */
async function readVoicePromptSnapshot(tenantId, opts = {}) {
  const { dbClient = db } = opts;
  const r = await dbClient.query(
    `SELECT voice_prompt_snapshot FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  return r.rows[0]?.voice_prompt_snapshot || null;
}

/**
 * Manually overwrite the snapshot's prompt text. Used by the admin PUT
 * endpoint when an owner edits the prompt by hand. Preserves metadata but
 * stamps a new generated_at.
 */
async function overwriteVoicePrompt(tenantId, newPromptText, opts = {}) {
  const { dbClient = db } = opts;
  if (typeof newPromptText !== "string" || newPromptText.trim().length < 50) {
    const err = new Error("prompt text must be a non-empty string of at least 50 characters");
    err.code = "INVALID_PROMPT";
    throw err;
  }
  const existing = await readVoicePromptSnapshot(tenantId, { dbClient });
  const snapshot = {
    prompt: newPromptText.trim(),
    generated_at: new Date().toISOString(),
    model: existing?.model || "manual-edit",
    source_data_hash: existing?.source_data_hash || null,
    version: SNAPSHOT_VERSION,
    edited_manually: true,
  };
  await dbClient.query(
    `UPDATE tenants
        SET voice_prompt_snapshot = $1::jsonb
      WHERE id = $2`,
    [JSON.stringify(snapshot), tenantId]
  );
  return snapshot;
}

/**
 * Clear the snapshot — tenant reverts to legacy code-rendered fallback.
 */
async function clearVoicePromptSnapshot(tenantId, opts = {}) {
  const { dbClient = db } = opts;
  await dbClient.query(
    `UPDATE tenants SET voice_prompt_snapshot = NULL WHERE id = $1`,
    [tenantId]
  );
}

// ── Tenant summary builder (generation input) ────────────────────────────

/**
 * Render the tenant's business context into a structured summary that Claude
 * can use as the basis for the generated prompt. Mirrors the chat path's
 * SERVICES/RATES blocks so the generated voice prompt references services,
 * resources, and staff with the same names and IDs the chat path uses.
 */
function buildTenantSummaryForGenerator(tenant, ctx) {
  const {
    services = [], memberships = [], rates = [], resources = [],
    staff = [], categories = [], prepaidProducts = [],
    resourceLinks = [], staffLinks = [], workingHours = [],
    serviceHours = [],
  } = ctx || {};

  // service_id → resources mapping
  const svcResources = {};
  resourceLinks.forEach(l => {
    (svcResources[l.service_id] = svcResources[l.service_id] || []).push({
      id: l.resource_id, name: l.resource_name,
    });
  });
  const svcStaff = {};
  staffLinks.forEach(l => {
    (svcStaff[l.service_id] = svcStaff[l.service_id] || []).push({
      id: l.staff_id, name: l.staff_name,
    });
  });

  // service_hours (per-service operating windows) by service
  const svcHours = {};
  serviceHours.forEach(r => {
    (svcHours[r.service_id] = svcHours[r.service_id] || []).push(r);
  });

  const fmtServiceLine = (s) => {
    const parts = [`${s.name}`, `service_id=${s.id}`];
    if (s.duration_minutes) parts.push(`${s.duration_minutes} min duration`);
    if (s.slot_interval_minutes) parts.push(`${s.slot_interval_minutes} min slot interval`);
    if (s.min_consecutive_slots && s.slot_interval_minutes) {
      parts.push(`min ${s.min_consecutive_slots * s.slot_interval_minutes} min`);
    }
    if (s.max_consecutive_slots && s.max_consecutive_slots > 1 && s.slot_interval_minutes) {
      parts.push(`max ${s.max_consecutive_slots * s.slot_interval_minutes} min`);
    }
    if (s.price != null) parts.push(`base price ${Number(s.price).toFixed(2)} ${s.currency_code || "JD"}`);
    if (s.allow_membership) parts.push(`PAYMENT: membership/package/cash/CliQ/card eligible`);
    else                    parts.push(`PAYMENT: cash/CliQ/card only — MEMBERSHIP NOT ACCEPTED`);
    if (s.description) parts.push(`description: "${s.description}"`);
    const linkedR = svcResources[s.id];
    if (linkedR && linkedR.length) {
      parts.push(`runs on resources: ${linkedR.map(r => `${r.name} (id ${r.id})`).join(", ")}`);
    }
    const linkedS = svcStaff[s.id];
    if (linkedS && linkedS.length) {
      parts.push(`requires staff: ${linkedS.map(st => `${st.name} (id ${st.id})`).join(", ")}`);
    }
    const hrs = svcHours[s.id];
    if (hrs && hrs.length) {
      const days = hrs.map(h => {
        const d = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][h.day_of_week];
        const open = trimSeconds(h.open_time);
        const close = trimSeconds(h.close_time);
        return `${d} ${open}-${close}`;
      }).join(", ");
      parts.push(`operating hours: ${days}`);
    }
    return `  - ${parts.join(" | ")}`;
  };

  const servicesBlock = services.length
    ? services.map(fmtServiceLine).join("\n")
    : "  (no services configured)";

  const membershipsBlock = memberships.length
    ? memberships.map(m => {
        const bits = [`${m.name} (id ${m.id})`];
        if (m.price != null) bits.push(`${Number(m.price).toFixed(2)} ${m.currency || "JD"}`);
        if (m.billing_type) bits.push(`billed ${m.billing_type}`);
        if (m.included_minutes) bits.push(`${m.included_minutes} min included`);
        if (m.included_uses) bits.push(`${m.included_uses} uses included`);
        if (m.validity_days) bits.push(`${m.validity_days}-day validity`);
        return `  - ${bits.join(" | ")}`;
      }).join("\n")
    : "  (no membership plans)";

  const packagesBlock = prepaidProducts.length
    ? prepaidProducts.map(p => {
        const bits = [`${p.name} (id ${p.id})`];
        if (p.price != null) bits.push(`${Number(p.price).toFixed(2)} JD`);
        if (p.product_type) bits.push(p.product_type);
        if (p.session_count) bits.push(`${p.session_count} sessions`);
        if (p.minutes_total) bits.push(`${p.minutes_total} min total`);
        return `  - ${bits.join(" | ")}`;
      }).join("\n")
    : "  (no prepaid packages)";

  const ratesBlock = rates.length
    ? rates.map(r => {
        const amt = r.amount != null
          ? (r.price_type === "fixed" ? `fixed ${Number(r.amount).toFixed(2)}`
             : r.price_type === "flat_fee" ? `flat ${Number(r.amount).toFixed(2)}`
             : r.price_type === "percent_discount" ? `${r.amount}% off`
             : `${Number(r.amount).toFixed(2)}`)
          : null;
        const days = Array.isArray(r.days_of_week) && r.days_of_week.length
          ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
              .filter((_, i) => r.days_of_week.includes(i)).join(",")
          : null;
        const time = r.time_start && r.time_end ? `${r.time_start}-${r.time_end}` : null;
        const forSvc = r.service_name ? `for ${r.service_name}` : "all services";
        const memOnly = r.membership_name ? `(${r.membership_name} only)`
                      : r.require_any_membership ? "(members only)" : null;
        return `  - ${r.name}: ${[amt, forSvc, days, time, memOnly].filter(Boolean).join(", ")}`;
      }).join("\n")
    : "  (no special rate rules)";

  const resourcesBlock = resources.length
    ? resources.map(r => `  - ${r.name} (id ${r.id})${r.capacity > 1 ? ` capacity ${r.capacity}` : ""}`).join("\n")
    : "  (no resources)";

  const staffBlock = staff.length
    ? staff.map(s => `  - ${s.name} (id ${s.id})`).join("\n")
    : "  (no staff)";

  const DAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const hoursBlock = workingHours.length
    ? workingHours.filter(h => !h.is_closed)
        .map(h => `  ${DAY[h.day_of_week] || h.day_of_week}: ${trimSeconds(h.open_time)} – ${trimSeconds(h.close_time)}`)
        .join("\n") || "  (no open days)"
    : "  (working hours not configured)";

  // Currency from the most common service
  const currency = (services.find(s => s.currency_code) || {}).currency_code || "JD";

  // Payment settings from branding (cash/cliq/card toggles)
  let paymentMethods = [];
  try {
    const branding = typeof tenant.branding === "string"
      ? JSON.parse(tenant.branding) : (tenant.branding || {});
    const ps = branding?.paymentSettings || {};
    if (ps.allow_cash !== false) paymentMethods.push("cash");
    if (ps.allow_cliq !== false) paymentMethods.push("CliQ");
    if (ps.allow_card !== false) paymentMethods.push("card");
  } catch { paymentMethods = ["cash", "CliQ", "card"]; }

  // Voice instructions (tenant's tone notes, may be empty)
  const tone = (tenant.voice_instructions || "").trim();

  return [
    `BUSINESS NAME: ${tenant.name}`,
    `SLUG: ${tenant.slug}`,
    `TIMEZONE: ${tenant.timezone || "Asia/Amman"}`,
    `CURRENCY: ${currency}`,
    `ENABLED PAYMENT METHODS: ${paymentMethods.join(", ") || "(none configured)"}`,
    "",
    "SERVICES:",
    servicesBlock,
    "",
    "MEMBERSHIP PLANS:",
    membershipsBlock,
    "",
    "PREPAID PACKAGES:",
    packagesBlock,
    "",
    "RATE RULES:",
    ratesBlock,
    "",
    "RESOURCES (physical units like simulator bays, rooms, courts):",
    resourcesBlock,
    "",
    "STAFF:",
    staffBlock,
    "",
    "BUSINESS-WIDE WORKING HOURS:",
    hoursBlock,
    "",
    tone
      ? `OWNER-PROVIDED TONE & PREFERENCES (must respect):\n${tone}`
      : "OWNER-PROVIDED TONE & PREFERENCES: (not configured — default to friendly, professional, concise)",
  ].join("\n");
}

// ── Meta-prompt builder ──────────────────────────────────────────────────

/**
 * The meta-prompt: instructions to Claude on HOW to generate the voice agent's
 * system prompt. This is the single piece of behavior that lives in code; the
 * generated output goes to the DB.
 */
function buildMetaPrompt({ tenant, tenantSummary }) {
  return `You are generating a system prompt for a real-time voice booking agent that runs on ElevenLabs Conversational AI for a specific business. The voice agent's job is to handle customer phone-style conversations that route through a backend tool called \`ask_booking_assistant\`. The backend tool executes all real database operations (availability checks, bookings, cancellations) — the voice agent itself does NOT have direct DB access.

Your task: produce a single self-contained system prompt that the voice agent will use as its base instructions. The prompt you generate must be tailored to this specific business — its services, vocabulary, payment rules, language preferences, and quirks. Do not produce a generic "voice agent" prompt; the whole point is that this prompt is per-tenant.

═══════════════════════════════════════════════════════════════════════
THE BUSINESS YOU ARE GENERATING FOR
═══════════════════════════════════════════════════════════════════════

${tenantSummary}

═══════════════════════════════════════════════════════════════════════
HARD REQUIREMENTS FOR THE GENERATED PROMPT
═══════════════════════════════════════════════════════════════════════

The prompt you generate MUST include the following sections, in this order. Do not omit any. Do not add other top-level sections.

1. ROLE & MISSION
   - Single short paragraph: "You are the voice booking concierge for {business name}. The customer reaches you through the business's public booking page. Your job is to help them check availability and book in a single, fast, friendly voice conversation."
   - State that the agent must call the \`ask_booking_assistant\` tool for ANY availability check, booking, cancellation, pricing question, or service-rule question.
   - State that the tool returns the spoken reply — the agent should pass the conversation through verbatim, since the tool already has full context about the business, services, prices, and the customer's account.
   - State the agent should call \`finish_session\` when the customer indicates they're done.
   - State the baseline language behaviour: "Detect the language the user is speaking and respond in the same language. If the user speaks Arabic, respond entirely in Arabic. If English, respond in English. Never mix languages within a single response." (Note: the backend may layer a session-level language lock on top of this at runtime — that lock takes precedence if present; this paragraph is the fallback.)

2. SERVICES THIS BUSINESS OFFERS (REFERENCE DATA)
   - List EVERY service from the business data above by name, with:
     - service_id (the agent forwards this to the tool)
     - duration / minimum booking length
     - which physical resources the service uses (e.g., "Karaoke runs on Sim Bay 1, 2, 3")
     - PAYMENT eligibility (whether membership is accepted, or only cash/CliQ/card)
     - Operating hours specific to that service if set
   - Include enough detail that the agent can disambiguate customer shorthand ("sim", "the bay", "karaoke") to the right service_id.
   - These are CONSTRAINTS, not live state. Make this clear: hours tell the agent WHEN the service runs, not whether a slot is FREE right now. Live availability requires calling the tool.

3. RESOURCE TOPOLOGY (CRITICAL — DON'T TREAT THIS AS OPTIONAL)

   List every physical resource (simulator bay, room, court, etc.) with its id and name. For each resource, name the services it can be booked for. This matters because:

   (a) Customers say things like "which sim is available for karaoke" — multiple services can run on the same physical resources, and the agent must recognize this is a valid question, not a category error. The agent forwards the question to ask_booking_assistant which returns per-resource availability.

   (b) When the customer names a specific resource ("Sim Bay 2"), the agent should include that resource by name in the forwarded query so the tool checks that specific bay.

   Format as a table-style list:
     - Sim Bay 1 (id 4) — used by: Golf Simulator, Karaoke
     - Sim Bay 2 (id 5) — used by: Golf Simulator, Karaoke
     - etc.

   (The exact mapping comes from the SERVICES section in the business data — every service that has "runs on resources" entries shares those resources.)

4. STAFF (if any)
   - List staff members with ids if the business has them. Note which services require staff.

5. PAYMENT METHODS THE BUSINESS ACCEPTS
   - List the payment methods enabled (cash / CliQ / card / membership / package).
   - Per-service eligibility: "membership is forbidden for service X because the tenant disabled it on that service."
   - Card and CliQ require the secure payment page — the agent should relay any redirect message verbatim.

6. RATE RULES (PRICING)
   - List the rate rules verbatim from the business data above. The agent never invents prices — it quotes from these rules or asks the tool.
   - Distinguish between member-only rates and general rates.

7. CURRENCY SPEAKING RULES (CRITICAL — must include verbatim or near-verbatim)

   When the configured currency is Jordanian Dinars (JD), include the following exact rules in the generated prompt:

     "When speaking prices aloud, always say 'dinar' / 'dinars' in English and 'دينار' / 'دنانير' in Arabic. Never say 'JOD', 'J-O-D', 'JD', or 'Jordanian dinar/s'. Never read decimal points aloud (no 'point zero zero', no 'point five zero'). Drop trailing zeros and convert decimals to natural speech:
       - 70.00 → 'seventy dinars' / 'سبعون ديناراً'
       - 12.50 → 'twelve and a half dinars' / 'اثنا عشر ديناراً ونصف'
       - 7.50 → 'seven and a half dinars' / 'سبعة دنانير ونصف'
       - 17.25 → 'seventeen and a quarter dinars' / 'سبعة عشر ديناراً وربع'
       - 1.00 → 'one dinar' / 'دينار واحد'
     Always speak the amount as a fluent native speaker would naturally say it — never as the digits appear in writing."

   For other currencies (USD, EUR, MYR, IDR, etc.), produce equivalent natural-speech rules. The principle is: never read the currency code, never read decimal points, drop trailing zeros, convert fractions to "and a half" / "and a quarter" style.

8. BUSINESS WORKING HOURS
   - List the business's working hours for each open day so the agent can answer "what time do you close?" instantly without a tool call.

9. BOOKING FLOW (THE CRITICAL MULTI-STEP — DO NOT SKIP STEPS)

   The agent MUST follow these steps when a customer wants to book. Skipping any step results in a fake confirmation (customer thinks they're booked but the system has no record). This has happened before and is the #1 failure mode.

   Step 1: When customer asks about availability or wants to book, forward to ask_booking_assistant. Pass the customer's question with the explicit date in YYYY-MM-DD format.
   Step 2: The tool returns availability info (specific times + per-resource breakdown). Read it back naturally to the customer.
   Step 3: When the customer picks a time, ask which payment method they want. Only list methods eligible for THAT service (read the PAYMENT eligibility from section 5 above). Examples:
            - For a service that accepts membership: "Cash, your Premium membership, the 10-pack, CliQ, or card?"
            - For a service that does NOT accept membership: "Cash, CliQ, or card?"
   Step 4: Confirm details out loud with price quoted from rate rules: "So that's Sim Bay 1, tonight at 7pm for two hours, paying cash, total seventeen and a half dinars — confirm?"
   Step 5: WHEN the customer says yes (yes/yeah/confirm/go ahead/book it/Arabic equivalents like نعم/أكد/احجز/تمام), call ask_booking_assistant with TWO things:
            (a) the confirmation query INCLUDING the chosen payment method explicitly: "Confirm Sim Bay 1 on 2026-05-09 at 19:00 for 2 hours, paying cash"
            (b) the is_confirming parameter set to true.
          The is_confirming=true tells the backend to execute the booking against the database. Without it, the backend treats the call as a re-statement and will NOT write the booking.
   Step 6: The tool returns a confirmation message. Read it back naturally. If it says the booking failed (slot just got taken, payment issue, etc.), apologize and offer alternatives — do not retry the same call.

   For card or CliQ payments: the tool will return a redirect message asking the customer to use the secure payment page. Speak that message back exactly. The booking is NOT created until the customer completes payment on the page. Do not promise SMS payment links.

   FINISHING THE CALL:
   When the customer indicates they're done ("that's all", "thanks bye", "all set", etc.), call the finish_session tool to end the call cleanly. Do not leave the call hanging with repeated "anything else?" prompts.

10. SERVICE NAME DISAMBIGUATION
    - For each common customer shorthand, map to the exact service_id (e.g., "sim" → Golf Simulator, service_id=16).
    - Pull these from the SERVICES section above; only include shortenings that are likely for THIS business.

11. CONVERSATION RULES
    - Speak naturally and concisely. Phone-style, not chat. Short sentences.
    - Don't read bullet points aloud.
    - Never invent — if you don't know, ask the tool or say so.
    - End calls cleanly when the customer is done; don't loop "anything else?" more than once.

12. OWNER-PROVIDED TONE & PREFERENCES
    - If the owner specified tone notes, weave them in. Examples: "always upsell Karaoke", "never offer discounts unannounced", "address customers formally in Arabic".
    - If empty, default to friendly, professional, concise.

═══════════════════════════════════════════════════════════════════════
WHAT NOT TO INCLUDE (CRITICAL)
═══════════════════════════════════════════════════════════════════════

- Do NOT include current customer information, today's date, or language-lock instructions. Those are appended at session start by the backend (different per session). Your generated prompt is tenant-specific and session-agnostic.
- Do NOT include anti-patterns or "wrong vs right" examples that mention specific times like "Sim 1 free at 5pm". Those become outdated.
- Do NOT use phrases like "do not call check_availability" — the backend tool always handles availability correctly; the agent should always forward.
- Do NOT include API examples, JSON schemas, or technical implementation details. The agent doesn't see ACTION blocks — it just calls the \`ask_booking_assistant\` tool with a natural-language query and an optional \`is_confirming\` boolean.

═══════════════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════════════

Output ONLY the generated system prompt. No preamble. No "here is the prompt:" line. No markdown code fences. Just the raw prompt text starting with "You are the voice booking concierge for ${tenant.name}." and ending naturally.

The prompt should be roughly 1500-3000 words. It must be self-contained: a fresh ElevenLabs agent with no other context should be able to handle a customer call using only this prompt + the \`ask_booking_assistant\` tool.

Begin.`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function trimSeconds(t) {
  if (!t) return "";
  const s = String(t);
  // "20:00:00" → "20:00"
  return s.length >= 5 ? s.slice(0, 5) : s;
}

module.exports = {
  generateVoicePromptForTenant,
  readVoicePromptSnapshot,
  overwriteVoicePrompt,
  clearVoicePromptSnapshot,
  // exposed for tests
  _internal: { buildTenantSummaryForGenerator, buildMetaPrompt },
};
