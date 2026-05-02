"use strict";

// utils/voiceContext.js
// ────────────────────────────────────────────────────────────────────────────
// VOICE-2: Builds the per-session system prompt override for the ElevenLabs
// Conversational AI agent.
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
 * @param {Object} args.tenant            Tenant row (must include name, timezone, voice_instructions)
 * @param {Object} args.businessContext   Output of fetchBusinessContext (services, memberships, rates, etc.)
 * @param {Object|null} args.customerData Output of fetchCustomerData if signed in, else null
 * @param {boolean} args.isSignedIn
 * @returns {string} The prompt override (pass as overrides.agent.prompt.prompt)
 */
function buildVoiceSystemPromptOverride({ tenant, businessContext, customerData, isSignedIn }) {
  const tenantName = tenant?.name || "this business";
  const tenantTz   = tenant?.timezone || "Asia/Amman";

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

  // ── Business context ─────────────────────────────────────────────────────
  const businessBlock = formatBusinessForVoice(tenantName, businessContext);

  // ── Customer context (signed-in only) ────────────────────────────────────
  const customerBlock = isSignedIn && customerData
    ? formatCustomerForVoice(customerData)
    : "CUSTOMER: Not signed in. Provide general business information only. Do NOT reveal other customers' data. If they want to book, gently let them know they'll need to sign in first.";

  // ── Per-tenant personality override ──────────────────────────────────────
  const personalityBlock = tenant?.voice_instructions && tenant.voice_instructions.trim().length > 0
    ? `\nTENANT-SPECIFIC TONE & PREFERENCES (always follow these on top of base instructions):\n${tenant.voice_instructions.trim()}\n`
    : "";

  // ── Voice-mode-specific behaviour rules ──────────────────────────────────
  // These augment the base agent prompt. The base prompt should say "you are
  // a booking concierge for {tenantName}; use ask_booking_assistant for any
  // availability/booking/cancellation work." This block adds the rules that
  // matter MOST for natural voice conversation.
  const voiceRules = `
VOICE CONVERSATION RULES:
- Speak naturally and concisely. This is a phone-style conversation, not a chat. Short sentences. No bullet points read aloud.
- When you have all the details for a booking (service, date, time, payment method) — confirm out loud and call ask_booking_assistant with the customer's confirmation phrase. The tool will return the booked confirmation.
- For availability checks: speak the top 2-3 best slots ("I have 5pm or 6pm — both peak slots"), don't enumerate all of them. The user can also see them as tappable pills.
- For pricing: always quote the actual price from the rate rules, never invent.
- Membership / prepaid: if the customer has remaining balance, proactively mention it as the default payment method ("I'll book it against your Pro membership — that uses 60 of your 240 remaining minutes").
- Card and CliQ payments: politely tell the customer those need the secure payment page on the booking site, but offer to take cash, membership credits, or prepaid package payment by voice.
- If you don't know something, say so — never invent.
- End calls cleanly when the customer is done. Don't keep the call open with "anything else?" loops more than once.

CURRENT DATE & TIME: ${nowStr}
- "Today" means: ${todayStr}
- "Tomorrow" means: ${tomorrowStr}
- Business timezone: ${tenantTz} (UTC offset: ${tzOffsetStr})
- When you call ask_booking_assistant with a time-sensitive question, always include the explicit date in YYYY-MM-DD format, never relative phrases like "tomorrow".
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

function formatBusinessForVoice(tenantName, ctx) {
  if (!ctx) return `BUSINESS: ${tenantName} (context unavailable)`;

  const { services = [], memberships = [], rates = [], resources = [], staff = [], categories = [], prepaidProducts = [], resourceLinks = [], staffLinks = [], workingHours = [] } = ctx;

  // Services with category grouping + linked resources/staff. Same data shape
  // claudeService.buildBusinessContext uses for the text chat path.
  const catMap = {};
  categories.forEach(c => { catMap[c.id] = c.name; });

  const serviceResourceMap = {};
  resourceLinks.forEach(l => {
    if (!serviceResourceMap[l.service_id]) serviceResourceMap[l.service_id] = [];
    serviceResourceMap[l.service_id].push({ id: l.resource_id, name: l.resource_name });
  });
  const serviceStaffMap = {};
  staffLinks.forEach(l => {
    if (!serviceStaffMap[l.service_id]) serviceStaffMap[l.service_id] = [];
    serviceStaffMap[l.service_id].push({ id: l.staff_id, name: l.staff_name });
  });

  const fmtSvc = (s) => {
    const price = s.price != null
      ? (Number(s.price) === 0 ? "Free" : `${Number(s.price).toFixed(2)} ${s.currency_code || "JD"}`)
      : "price on request";
    const dur = s.duration_minutes ? `${s.duration_minutes} min` : null;
    const interval = s.slot_interval_minutes ? `${s.slot_interval_minutes} min slots` : null;
    const allowMem = s.allow_membership ? "membership ok" : null;
    const desc = s.description ? `"${s.description}"` : null;
    const linkedR = serviceResourceMap[s.id];
    const resStr = linkedR && linkedR.length ? `resources: ${linkedR.map(r => `${r.name} [resource_id:${r.id}]`).join(", ")}` : null;
    const linkedS = serviceStaffMap[s.id];
    const staffStr = linkedS && linkedS.length ? `staff: ${linkedS.map(st => `${st.name} [staff_id:${st.id}]`).join(", ")}` : null;
    const parts = [dur, interval, price, allowMem, resStr, staffStr, desc].filter(Boolean).join(" | ");
    return `  - ${s.name} [service_id:${s.id}]: ${parts}`;
  };

  let servicesBlock;
  if (services.length === 0) {
    servicesBlock = "  No services configured.";
  } else if (categories.length > 0) {
    const grouped = {};
    const uncat = [];
    services.forEach(s => {
      const cat = s.category_id && catMap[s.category_id];
      if (cat) { (grouped[cat] = grouped[cat] || []).push(s); } else uncat.push(s);
    });
    const blocks = Object.entries(grouped).map(([c, svcs]) => `  [${c}]\n${svcs.map(fmtSvc).join("\n")}`);
    if (uncat.length) blocks.push(`  [Other]\n${uncat.map(fmtSvc).join("\n")}`);
    servicesBlock = blocks.join("\n\n");
  } else {
    servicesBlock = services.map(fmtSvc).join("\n");
  }

  const membershipsBlock = memberships.length
    ? memberships.map(m => {
        const price = m.price != null ? `${Number(m.price).toFixed(2)} ${m.currency || "JD"}` : null;
        const billing = m.billing_type ? `billed ${m.billing_type}` : null;
        const mins = m.included_minutes ? `${m.included_minutes} min included` : null;
        const uses = m.included_uses ? `${m.included_uses} uses included` : null;
        const validity = m.validity_days ? `${m.validity_days}-day validity` : null;
        const parts = [price, billing, mins, uses, validity].filter(Boolean).join(" | ");
        return `  - ${m.name} [id:${m.id}]: ${parts}`;
      }).join("\n")
    : "  No membership plans.";

  const prepaidBlock = prepaidProducts.length
    ? prepaidProducts.map(p => {
        const price = p.price != null ? `${Number(p.price).toFixed(2)} JD` : null;
        const sessions = p.session_count ? `${p.session_count} sessions` : null;
        const minutes = p.minutes_total ? `${p.minutes_total} min` : null;
        const credits = p.credit_amount ? `${p.credit_amount} credits` : null;
        const parts = [price, p.product_type, sessions, minutes, credits].filter(Boolean).join(" | ");
        return `  - ${p.name} [id:${p.id}]: ${parts}`;
      }).join("\n")
    : "  No prepaid packages.";

  const ratesBlock = rates.length
    ? rates.map(r => {
        const amt = r.amount != null
          ? (r.price_type === "fixed" ? `fixed ${Number(r.amount).toFixed(2)}`
             : r.price_type === "flat_fee" ? `flat ${Number(r.amount).toFixed(2)}`
             : r.price_type === "percent_discount" ? `${r.amount}% off`
             : `${Number(r.amount).toFixed(2)}`)
          : null;
        const days = Array.isArray(r.days_of_week) && r.days_of_week.length
          ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].filter((_,i) => r.days_of_week.includes(i)).join(",")
          : null;
        const time = r.time_start && r.time_end ? `${r.time_start}-${r.time_end}` : null;
        const forSvc = r.service_name ? `for ${r.service_name}` : "all services";
        const memOnly = r.membership_name ? `(${r.membership_name} only)`
                      : r.require_any_membership ? "(members only)" : null;
        return `  - ${r.name}: ${[amt, forSvc, days, time, memOnly].filter(Boolean).join(", ")}`;
      }).join("\n")
    : "  No special rate rules.";

  const resourcesBlock = resources.length
    ? resources.map(r => `  - ${r.name} [id:${r.id}]${r.capacity > 1 ? ` (capacity ${r.capacity})` : ""}`).join("\n")
    : "  No resources listed.";

  const staffBlock = staff.length
    ? staff.map(s => `  - ${s.name} [id:${s.id}]`).join("\n")
    : "  No staff listed.";

  const DAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const hoursBlock = workingHours.length
    ? workingHours.filter(h => !h.is_closed).map(h => `  ${DAY[h.day_of_week] || h.day_of_week}: ${h.open_time} – ${h.close_time}`).join("\n") || "  No open days."
    : "  Hours: see booking page.";

  return `BUSINESS: ${tenantName}

SERVICES (use service_id when calling ask_booking_assistant):
${servicesBlock}

MEMBERSHIP PLANS:
${membershipsBlock}

PREPAID PACKAGES:
${prepaidBlock}

RATE RULES (peak hours, member discounts, etc — always quote real prices from these):
${ratesBlock}

RESOURCES:
${resourcesBlock}

STAFF:
${staffBlock}

WORKING HOURS:
${hoursBlock}`;
}

function formatCustomerForVoice(c) {
  if (!c?.profile) return "CUSTOMER: Signed in but profile data unavailable.";

  const { profile, bookings = [], memberships = [], packages = [] } = c;
  const now = Date.now();

  const upcoming = bookings
    .filter(b => b.start_time && new Date(b.start_time).getTime() >= now && b.status !== "cancelled")
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .slice(0, 5);

  const upcomingBlock = upcoming.length
    ? upcoming.map(b => {
        const dt = new Date(b.start_time).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
        return `  - [booking_id:${b.id}] ${b.service_name || "Service"} | ${dt} | ${b.duration_minutes || "?"}min | ${b.status}`;
      }).join("\n")
    : "  None";

  const membershipsBlock = memberships.length
    ? memberships.map(m => {
        const bal = m.minutes_remaining != null ? `${m.minutes_remaining} min remaining`
                  : m.uses_remaining != null    ? `${m.uses_remaining} uses remaining`
                  : "balance unknown";
        const exp = m.end_at ? `expires ${new Date(m.end_at).toLocaleDateString("en-GB")}` : "";
        return `  - [membership_id:${m.id}] ${m.plan_name || "Plan"} | ${m.status || "?"} | ${bal}${exp ? " | " + exp : ""}`;
      }).join("\n")
    : "  None";

  const packagesBlock = packages.length
    ? packages.map(p => {
        const rem = p.remaining_quantity != null ? `${p.remaining_quantity}/${p.original_quantity || "?"}` : "?";
        const exp = p.expires_at ? `expires ${new Date(p.expires_at).toLocaleDateString("en-GB")}` : "";
        return `  - [package_id:${p.id}] ${p.product_name || "Package"} | ${p.status} | ${rem} remaining${exp ? " | " + exp : ""}`;
      }).join("\n")
    : "  None";

  return `CUSTOMER: ${profile.name || "Customer"} (${profile.email}${profile.phone ? `, ${profile.phone}` : ""})
- Member since: ${profile.created_at ? new Date(profile.created_at).toLocaleDateString("en-GB") : "N/A"}

UPCOMING BOOKINGS:
${upcomingBlock}

ACTIVE MEMBERSHIPS:
${membershipsBlock}

PREPAID PACKAGES:
${packagesBlock}`;
}

module.exports = { buildVoiceSystemPromptOverride };
