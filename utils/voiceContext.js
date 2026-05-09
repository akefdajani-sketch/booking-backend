"use strict";

// utils/voiceContext.js
// ────────────────────────────────────────────────────────────────────────────
// VOICE-2: Builds the per-session system prompt override for the ElevenLabs
// Conversational AI agent.
//
// BOOKING-PAYMENT-METHOD-FIX-1 (this revision):
//   - Resolves the contradiction at the old "send a payment link after
//     booking" line for card/CliQ — that flow doesn't exist; the backend
//     returns a "use the Book now button" redirect message. The voice rule
//     now matches the actual backend behaviour: agent tells the customer
//     it'll send them to the secure booking page.
//   - Tells the agent to ALWAYS include the customer's chosen payment
//     method (one of: membership, package, cash, card, cliq) in the
//     query string when invoking ask_booking_assistant to create a
//     booking — so the booking-assistant tool captures it deterministically
//     instead of inferring it from history.
//   - Pairs with claudeService.js (which gains payment_method in
//     PENDING_BOOKING and create_booking ACTION schemas + a PAYMENT METHOD
//     FIELD rule) and with frontend changes to PendingBooking type +
//     PendingBookingCard "Pay" row.
//
// VOICE-CONTEXT-1.1 / BOOKING-RULES-FIX-1:
//   - BOOKING-RULES-FIX-1: makes per-service payment eligibility EXPLICIT.
//     "membership ok" was too easy for the LLM to read as descriptive
//     metadata rather than a hard constraint, which led to the agent
//     offering membership payment for services like Karaoke that have
//     allow_membership=false. Now each service line includes a PAYMENT
//     field stating both the eligible methods AND (when forbidden)
//     "MEMBERSHIP NOT ACCEPTED" outright. The accompanying rule tells
//     the agent to ONLY offer methods listed in that field.
//   - VOICE-CONTEXT-1.1: Adds LANGUAGE MIRRORING rule: respond in the customer's language
//     (Arabic or English), never mix within a single response. Allows
//     keeping service names in their original English form ("Golf
//     Simulator", "Karaoke") since customers use them that way locally.
//     Belt-and-braces with the EL agent's own language instruction.
//
// VOICE-CONTEXT-1 (parent revision):
//   - Adds a CUSTOMER PAYMENT OPTIONS block: aggregates customer memberships,
//     prepaid packages, and the tenant's enabled payment methods (cash/cliq/
//     card) into a single readable list. The agent uses this to ALWAYS ask
//     the customer how they want to pay before confirming a booking.
//   - Adds per-service operating hours (service_hours table) so the agent
//     can answer "is karaoke open Sunday morning?" with the actual rule
//     ("Karaoke runs 8pm–2am, 2-hour minimum") instead of just running an
//     empty availability check.
//   - Adds explicit BOOKING-RULE GUIDANCE: when the customer asks for
//     something outside the rules (wrong day, wrong time, below minimum
//     duration), explain WHY and offer the nearest valid alternative —
//     don't just say "no slots".
//   - Adds DISAMBIGUATION GUIDANCE: customers shorten service names ("sim"
//     for Golf Simulator). Map flexibly; ask if genuinely ambiguous.
//   - Fixes a latent bug: tenant.voice_instructions was being read but
//     getTenantBySlug() never loaded that column. routes/voice.js now
//     enriches the tenant row before calling this function.
//
// WHY THIS EXISTS:
// The text chat path (routes/ai.js) reloads tenant + customer context on
// EVERY message. For an 8-turn voice conversation that would mean ~80 SQL
// queries with column-existence probes — slow and wasteful. Voice context
// rarely changes mid-call, so we bake it ONCE into the agent's system prompt
// when the session opens, and the agent carries it for the entire call.
//
// The actual booking actions (check_availability, create_booking, etc.) call
// back to our ask_booking_assistant tool which goes through the normal
// runSupportAgent path — that's where we re-fetch customer data so live
// changes (a booking created mid-call, membership credits debited) stay
// accurate.
//
// SHAPE OF THE OVERRIDE:
// ElevenLabs agents have a base system prompt configured in their dashboard
// (e.g. "You are a booking concierge. Use the ask_booking_assistant tool
// for any availability check, booking, or cancellation."). We send our
// override under `overrides.agent.prompt.prompt`, which the agent prepends
// to its base prompt for this session only.
//
// Per the ElevenLabs docs, the agent must have "Override system prompt"
// enabled in Security → Overrides for this to take effect. Same setting
// the clawbot voice integration uses.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the per-session system prompt override for a voice call.
 *
 * @param {Object} args
 * @param {Object} args.tenant            Tenant row (must include name, timezone, voice_instructions, branding)
 * @param {Object} args.businessContext   Output of fetchBusinessContext (services, memberships, rates, serviceHours, etc.)
 * @param {Object|null} args.customerData Output of fetchCustomerData if signed in, else null
 * @param {boolean} args.isSignedIn
 * @returns {string} The prompt override (pass as overrides.agent.prompt.prompt)
 */
function buildVoiceSystemPromptOverride({ tenant, businessContext, customerData, isSignedIn, lang = "en" }) {
  const tenantName = tenant?.name || "this business";
  const tenantTz   = tenant?.timezone || "Asia/Amman";

  // VOICE-FIX-4: Session language is locked at startup by the customer's
  // language toggle. ElevenLabs uses different TTS models per language
  // ("v2" for English-only, "v2.5 Multilingual" for everything else), so
  // generating Arabic text in an English-locked session produces phonetically
  // butchered output ("lame Arabic accent"). The button is the single source
  // of truth — Claude must respond in the locked language regardless of what
  // language the customer happens to speak.
  const sessionLang = lang === "ar" ? "Arabic" : "English";
  const otherLang   = lang === "ar" ? "English" : "Arabic";

  // Compute current date/time in the tenant's TZ. The agent needs this so
  // it can interpret "tomorrow" / "this Saturday" against the right day.
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tenantTz });
  const nowStr   = now.toLocaleString("en-GB", {
    timeZone: tenantTz, dateStyle: "full", timeStyle: "short",
  });
  const tomorrowStr = new Date(now.getTime() + 86400000).toLocaleDateString("en-CA", { timeZone: tenantTz });

  // Tenant timezone offset string (e.g. "+03:00") — needed so that any time
  // strings the agent constructs include the right offset when handed back
  // through the ask_booking_assistant tool.
  const tzOffsetStr = computeTzOffset(tenantTz, now);

  // Resolve which payment methods the tenant accepts (from branding JSONB).
  const paymentSettings = resolveTenantPaymentSettings(tenant);

  // ── Business context ─────────────────────────────────────────────────────
  const businessBlock = formatBusinessForVoice(tenantName, businessContext);

  // ── Customer context (signed-in only) ────────────────────────────────────
  const customerBlock = isSignedIn && customerData
    ? formatCustomerForVoice(customerData, paymentSettings, tenantTz)
    : `CUSTOMER: Not signed in. Provide general business information only. Do NOT reveal other customers' data. If they want to book, gently let them know they'll need to sign in first.

PAYMENT OPTIONS (for general info — booking requires sign-in):
${formatTenantPaymentMethods(paymentSettings)}`;

  // ── Per-tenant personality override ──────────────────────────────────────
  const personalityBlock = tenant?.voice_instructions && tenant.voice_instructions.trim().length > 0
    ? `\nTENANT-SPECIFIC TONE & PREFERENCES (always follow these on top of base instructions):\n${tenant.voice_instructions.trim()}\n`
    : "";

  // ── Voice-mode-specific behaviour rules ──────────────────────────────────
  // VOICE-FIX-5: Stripped down to a thin forwarder. Previous version had
  // SERVICES/rate-rules/payment-eligibility/booking-rules baked into the
  // prompt, which tempted the EL agent to answer from prompt context instead
  // of calling ask_booking_assistant. The agent's only job is now:
  //   1. Greet by name + lock to chosen language
  //   2. Disambiguate service nicknames in the forwarded query
  //   3. Speak currency naturally
  //   4. Forward EVERYTHING booking-related to ask_booking_assistant
  // Booking logic, rates, payment eligibility, availability rules — all live
  // in Claude's prompt (claudeService.js) and the engine. Per-tenant prompt
  // generation (Tier-3 backlog) will replace this with tenant-specific
  // versions in the DB.
  const voiceRules = `
VOICE CONVERSATION RULES:
- Speak naturally and concisely. This is a phone-style conversation, not a chat. Short sentences. No bullet points read aloud.
- If you don't know something, say so — never invent.
- End calls cleanly when the customer is done. Don't keep the call open with "anything else?" loops more than once.

TOOL USAGE — ALWAYS FORWARD TO ask_booking_assistant (REQUIRED):
- For ANY question about availability, booking, cancellation, pricing, services, memberships, packages, or rules — call ask_booking_assistant.
- Pass the customer's question forward. The tool has full access to the live database; it will return the correct answer including real-time availability, conflicts, prices, and rules.
- Do NOT answer availability questions from this prompt. The hours/services blocks below are reference data, not live state. Whether a slot is FREE right now is something only the database knows — and only the tool can check.
- The only things you can answer WITHOUT the tool are: trivia about the business (name, working hours, location, what services exist by name), greetings, and small talk. EVERYTHING else goes to the tool.

SERVICE NAME DISAMBIGUATION (before forwarding):
- Customers shorten service names. When you forward to ask_booking_assistant, expand to the closest service name from the SERVICES list below if they used a shortened form:
  - "sim" / "simulator" / "the bay" / "indoor" → "Simulator" service
  - "lesson" / "coaching" → "Lesson" service
  - "mini" / "putt-putt" → "Mini Golf"
- If the shortening is ambiguous (multiple matches), ask one short clarifying question before forwarding.

PAYMENT FLOW (after forwarding for availability):
- The tool will tell you which payment methods are eligible for the chosen service and which the customer has available. Read those back to the customer and ask which one.
- Card and CliQ payments need the secure payment page — relay any redirect message from the tool exactly as given. Don't invent payment links.
- After the customer chooses a payment method, forward the confirmation request to ask_booking_assistant including the chosen payment method explicitly in the query (e.g. "Confirm Sim Bay 1 on 2026-05-04 at 17:00, paying cash").

LANGUAGE LOCK (VOICE-FIX-4 — session is locked to ${sessionLang}):
- This session is locked to ${sessionLang} by the customer's language toggle. Always respond in ${sessionLang} regardless of what language the customer speaks. Never mix languages within a single response.
- If the customer speaks ${otherLang} during a ${sessionLang} session, respond in ${sessionLang} and gently let them know once: ${lang === "ar"
    ? '"الجلسة مضبوطة على العربية حالياً — يمكنك التبديل للإنجليزية من زر اللغة في الأعلى."'
    : '"This session is set to English — you can switch to Arabic using the language toggle at the top."'}
- After mentioning the language toggle once per session, do NOT keep repeating it — just continue answering in ${sessionLang}.
- Service names may stay in English (e.g. "Karaoke", "Golf Simulator") even within Arabic responses — customers use them that way locally.
- Numbers, times, currencies, and dates follow ${sessionLang}: ${lang === "ar"
    ? 'use Arabic-language time phrasing ("الساعة الخامسة"), Arabic numerals are fine.'
    : 'use English ("five o\'clock", "twelve fifty piasters").'}
- These rules apply both to your spoken output AND to the text reply returned by ask_booking_assistant. The tool will respect the session language.

CURRENT DATE & TIME: ${nowStr}
- "Today" means: ${todayStr}
- "Tomorrow" means: ${tomorrowStr}
- Business timezone: ${tenantTz} (UTC offset: ${tzOffsetStr})
- When forwarding to ask_booking_assistant, always include the explicit date in YYYY-MM-DD format, never relative phrases like "tomorrow".
`;

  return `You are the voice booking concierge for ${tenantName}. Your job is to help customers check availability and book in a single, fast, friendly conversation.

${personalityBlock}${voiceRules}

${businessBlock}

${customerBlock}`;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function computeTzOffset(tz, when) {
  try {
    const offsetPart = new Intl.DateTimeFormat("en", {
      timeZone: tz, timeZoneName: "longOffset",
    }).formatToParts(when).find(p => p.type === "timeZoneName")?.value || "GMT+0";
    const m = offsetPart.match(/GMT([+\-])(\d+)(?::(\d{2}))?/);
    if (!m) return "+00:00";
    return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] || "00").padStart(2, "00")}`;
  } catch { return "+00:00"; }
}

/**
 * Resolve which payment methods the tenant accepts.
 * Settings live in tenants.branding->>'paymentSettings' (per migration 019):
 *   { allow_card: true, allow_cliq: true, allow_cash: false }
 * Defaults: card=on, cliq=on, cash=OFF (tenant must opt in).
 */
function resolveTenantPaymentSettings(tenant) {
  const defaults = { allow_card: true, allow_cliq: true, allow_cash: false };
  try {
    const branding = typeof tenant?.branding === "string"
      ? JSON.parse(tenant.branding)
      : tenant?.branding;
    const ps = branding?.paymentSettings || {};
    return {
      allow_card: ps.allow_card !== false,  // default true
      allow_cliq: ps.allow_cliq !== false,  // default true
      allow_cash: ps.allow_cash === true,   // default false
    };
  } catch {
    return defaults;
  }
}

/**
 * Render the tenant-level payment methods (cash/cliq/card) as a short list.
 * Used in the customer block (signed-in or not).
 */
function formatTenantPaymentMethods(ps) {
  const methods = [];
  if (ps?.allow_cash) methods.push("Cash at venue (confirm by voice)");
  if (ps?.allow_cliq) methods.push("CliQ — needs the secure payment page (offer the customer a payment link after booking)");
  if (ps?.allow_card) methods.push("Card — needs the secure payment page (offer the customer a payment link after booking)");
  if (methods.length === 0) return "  (No external payment methods enabled — only membership/package can cover bookings)";
  return methods.map(m => `  - ${m}`).join("\n");
}

/**
 * Format the per-service operating hours into a compact human-readable
 * summary for use inside the SERVICES block. Multiple consecutive same-time
 * days are collapsed (e.g. "Mon-Sat 8pm-2am").
 */
function formatServiceHoursSummary(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const DAY_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  // Group by (open_time + close_time) → set of day_of_week
  const byWindow = new Map();
  for (const r of rows) {
    const key = `${trimSeconds(r.open_time)}-${trimSeconds(r.close_time)}`;
    if (!byWindow.has(key)) byWindow.set(key, new Set());
    byWindow.get(key).add(Number(r.day_of_week));
  }
  // Render
  const parts = [];
  for (const [window, days] of byWindow) {
    const dayList = [...days].sort((a, b) => a - b);
    parts.push(`${formatDayRange(dayList, DAY_SHORT)} ${formatTimeWindow(window)}`);
  }
  return parts.join(", ");
}

function trimSeconds(t) {
  if (!t) return t;
  const s = String(t);
  return s.length === 8 && s.endsWith(":00") ? s.slice(0, 5) : s;
}

function formatTimeWindow(win) {
  // win is "HH:MM-HH:MM"
  const [a, b] = win.split("-");
  return `${humanTime(a)}-${humanTime(b)}`;
}

function humanTime(hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}/.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  if (m === 0) {
    if (h === 0)  return "midnight";
    if (h === 12) return "noon";
    if (h < 12)   return `${h}am`;
    return `${h - 12}pm`;
  }
  const ampm = h < 12 ? "am" : "pm";
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

function formatDayRange(days, names) {
  if (days.length === 7) return "Daily";
  // Detect contiguous run
  if (isContiguous(days)) {
    return `${names[days[0]]}-${names[days[days.length - 1]]}`;
  }
  return days.map(d => names[d]).join(",");
}

function isContiguous(days) {
  if (days.length < 2) return true;
  for (let i = 1; i < days.length; i++) {
    if (days[i] !== days[i - 1] + 1) return false;
  }
  return true;
}

function formatBusinessForVoice(tenantName, ctx) {
  if (!ctx) return `BUSINESS: ${tenantName} (context unavailable)`;

  const {
    services = [], workingHours = [],
  } = ctx;

  // VOICE-FIX-5: Stripped down to TRIVIA ONLY — name, working hours, service
  // names. Previous version had per-service operating hours, rate rules,
  // payment eligibility, resources, staff lists, memberships, packages — all
  // of which tempted the EL agent to answer questions from prompt context
  // instead of forwarding to ask_booking_assistant.
  //
  // The agent now needs ONLY:
  //   - Tenant name (for greeting)
  //   - Working hours (so "what time do you close" doesn't need a tool call)
  //   - Service names (for disambiguation when forwarding queries)
  //
  // Everything else — prices, rates, eligibility, conflicts, availability,
  // staff schedules, resource selection — is the tool's job. Claude's
  // prompt (claudeService.js) has the full context for tool responses.

  const serviceNames = services.length
    ? services.map(s => s.name).join(", ")
    : "(none configured)";

  const DAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const hoursBlock = workingHours.length
    ? workingHours.filter(h => !h.is_closed).map(h => `  ${DAY[h.day_of_week] || h.day_of_week}: ${trimSeconds(h.open_time)} – ${trimSeconds(h.close_time)}`).join("\n") || "  No open days."
    : "  Hours: see booking page.";

  return `BUSINESS: ${tenantName}

SERVICES OFFERED (names only — for disambiguation when forwarding queries to ask_booking_assistant; all booking details, prices, hours, eligibility live in the tool):
  ${serviceNames}

BUSINESS WORKING HOURS:
${hoursBlock}`;
}

function formatCustomerForVoice(c, paymentSettings, tenantTz = "Asia/Amman") {
  if (!c?.profile) return "CUSTOMER: Signed in but profile data unavailable.";

  const { profile, bookings = [] } = c;
  const now = Date.now();

  // VOICE-FIX-5: Stripped the membership/package/payment-option blocks.
  // Those tempted the EL agent to enumerate payment options from prompt
  // context — and then recommend membership for services where membership
  // wasn't accepted (because it had no per-service eligibility data).
  // The TOOL (ask_booking_assistant) always returns the correct, eligible
  // payment options for the chosen service. The agent's job is to relay
  // those, not invent them.
  //
  // What's kept: name (for greeting) + upcoming bookings (so the agent can
  // naturally say "your existing sim 3 booking" without a tool call when
  // the customer references something they just booked).

  const upcoming = bookings
    .filter(b => b.start_time && new Date(b.start_time).getTime() >= now && b.status !== "cancelled")
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .slice(0, 5);

  const upcomingBlock = upcoming.length
    ? upcoming.map(b => {
        const dt = new Date(b.start_time).toLocaleString("en-GB", { timeZone: tenantTz, dateStyle: "medium", timeStyle: "short" });
        return `  - [booking_id:${b.id}] ${b.service_name || "Service"} | ${dt} | ${b.duration_minutes || "?"}min | ${b.status}`;
      }).join("\n")
    : "  None";

  return `CUSTOMER: ${profile.name || "Customer"} (${profile.email}${profile.phone ? `, ${profile.phone}` : ""})

UPCOMING BOOKINGS (for natural reference only — for any new availability/booking/cancellation, ALWAYS forward to ask_booking_assistant which has the live state):
${upcomingBlock}`;
}

module.exports = { buildVoiceSystemPromptOverride };
