"use strict";

// utils/voiceContext.js
// ────────────────────────────────────────────────────────────────────────────
// VOICE-2: Builds the per-session system prompt override for the ElevenLabs
// Conversational AI agent.
//
// VOICE-CONTEXT-1 (this revision):
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

  // Resolve which payment methods the tenant accepts (from branding JSONB).
  const paymentSettings = resolveTenantPaymentSettings(tenant);

  // ── Business context ─────────────────────────────────────────────────────
  const businessBlock = formatBusinessForVoice(tenantName, businessContext);

  // ── Customer context (signed-in only) ────────────────────────────────────
  const customerBlock = isSignedIn && customerData
    ? formatCustomerForVoice(customerData, paymentSettings)
    : `CUSTOMER: Not signed in. Provide general business information only. Do NOT reveal other customers' data. If they want to book, gently let them know they'll need to sign in first.

PAYMENT OPTIONS (for general info — booking requires sign-in):
${formatTenantPaymentMethods(paymentSettings)}`;

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
- For availability checks: speak the top 2-3 best slots ("I have 5pm or 6pm — both peak slots"), don't enumerate all of them. The user can also see them as tappable pills.
- For pricing: always quote the actual price from the rate rules, never invent.
- If you don't know something, say so — never invent.
- End calls cleanly when the customer is done. Don't keep the call open with "anything else?" loops more than once.

PAYMENT — ALWAYS ASK BEFORE CONFIRMING:
- Before calling ask_booking_assistant to CREATE a booking, you MUST know how the customer wants to pay.
- If the customer has a membership and/or a prepaid package that could cover the booking, list them as options. Do NOT default for them.
- Phrase the question naturally: "How would you like to pay — your Premium membership has 240 minutes left, you've got 6 sessions on the 10-pack, or we can take cash, CliQ, or card?"
- Card and CliQ payments need the secure payment page on the booking site. If the customer chooses card or CliQ, tell them you'll send a payment link after booking.
- Cash, membership, and prepaid package payments can be confirmed by voice.
- After booking, confirm the deduction out loud if a membership or package was used: "Booked. 1 hour deducted from Premium — 7 left."

BOOKING RULES — EXPLAIN, DON'T BLINDLY CHECK:
- Each service may have its own operating window (see SERVICES list — "hours:" notes per service). If the customer asks for a time outside that window, do NOT call check_availability — that just returns empty results and frustrates the customer.
- Instead, EXPLAIN the rule and offer the nearest valid alternative. Example: customer asks "karaoke at 6am Sunday" → "Karaoke runs 8pm-2am with a 2-hour minimum, so 6am isn't available. I can check Sunday evening — 8pm or 10pm work?"
- Same for minimum/maximum duration: if a customer says "30 minutes of karaoke" but karaoke is 2-hour minimum (read the "min X min" note on the service), explain the minimum before checking availability.
- Same for tenant-wide closed days: if the business is closed Sundays and the customer asks for Sunday, say so directly.

SERVICE NAME DISAMBIGUATION:
- Customers shorten service names. Map flexibly to the closest service name in the SERVICES list:
  - "sim" / "simulator" / "the bay" / "indoor" → match the service whose name contains "Simulator" (or similar)
  - "lesson" / "coaching" → match a service whose name contains "Lesson"
  - "mini" / "putt-putt" → match a service whose name contains "Mini"
  - In general, do partial-name matching against the SERVICES list before asking.
- If a shortening is genuinely ambiguous (multiple services match), ask one short clarifying question: "The simulator or mini golf?"
- If exact-name matching works, use it without asking.

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
    services = [], memberships = [], rates = [], resources = [],
    staff = [], categories = [], prepaidProducts = [],
    resourceLinks = [], staffLinks = [], workingHours = [],
    serviceHours = [],
  } = ctx;

  // Group service_hours rows by service_id for quick lookup
  const serviceHoursByService = {};
  serviceHours.forEach(r => {
    if (!serviceHoursByService[r.service_id]) serviceHoursByService[r.service_id] = [];
    serviceHoursByService[r.service_id].push(r);
  });

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
    const slotInt = Number(s.slot_interval_minutes) || null;
    const minSlots = Number(s.min_consecutive_slots) || null;
    const maxSlots = Number(s.max_consecutive_slots) || null;
    const minDur = (slotInt && minSlots) ? `min ${slotInt * minSlots} min` : null;
    const maxDur = (slotInt && maxSlots && maxSlots > 1)
      ? `max ${slotInt * maxSlots} min`
      : null;
    const allowMem = s.allow_membership ? "membership ok" : null;
    const desc = s.description ? `"${s.description}"` : null;
    const linkedR = serviceResourceMap[s.id];
    const resStr = linkedR && linkedR.length ? `resources: ${linkedR.map(r => `${r.name} [resource_id:${r.id}]`).join(", ")}` : null;
    const linkedS = serviceStaffMap[s.id];
    const staffStr = linkedS && linkedS.length ? `staff: ${linkedS.map(st => `${st.name} [staff_id:${st.id}]`).join(", ")}` : null;
    const hoursSummary = formatServiceHoursSummary(serviceHoursByService[s.id]);
    const hoursStr = hoursSummary ? `hours: ${hoursSummary}` : null;
    const parts = [dur, interval, minDur, maxDur, price, allowMem, hoursStr, resStr, staffStr, desc].filter(Boolean).join(" | ");
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
    ? workingHours.filter(h => !h.is_closed).map(h => `  ${DAY[h.day_of_week] || h.day_of_week}: ${trimSeconds(h.open_time)} – ${trimSeconds(h.close_time)}`).join("\n") || "  No open days."
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

BUSINESS WORKING HOURS (tenant-wide; per-service hours appear inline above as "hours:" notes):
${hoursBlock}`;
}

function formatCustomerForVoice(c, paymentSettings) {
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

  // Active memberships only — agent should only offer membership credits
  // that are actually usable right now.
  const activeMemberships = memberships.filter(m => {
    if (!m.status) return true;
    return ["active", "current"].includes(String(m.status).toLowerCase());
  });

  const membershipsBlock = activeMemberships.length
    ? activeMemberships.map(m => {
        const bal = m.minutes_remaining != null ? `${m.minutes_remaining} min remaining`
                  : m.uses_remaining != null    ? `${m.uses_remaining} uses remaining`
                  : "balance unknown";
        const exp = m.end_at ? `expires ${new Date(m.end_at).toLocaleDateString("en-GB")}` : "";
        return `  - [membership_id:${m.id}] ${m.plan_name || "Plan"} | ${m.status || "?"} | ${bal}${exp ? " | " + exp : ""}`;
      }).join("\n")
    : "  None";

  // Active packages only — agent should not offer packages that are expired
  // or fully consumed.
  const activePackages = packages.filter(p => {
    if (p.remaining_quantity != null && Number(p.remaining_quantity) <= 0) return false;
    if (p.status && !["active", "current"].includes(String(p.status).toLowerCase())) return false;
    return true;
  });

  const packagesBlock = activePackages.length
    ? activePackages.map(p => {
        const rem = p.remaining_quantity != null ? `${p.remaining_quantity}/${p.original_quantity || "?"}` : "?";
        const exp = p.expires_at ? `expires ${new Date(p.expires_at).toLocaleDateString("en-GB")}` : "";
        return `  - [package_id:${p.id}] ${p.product_name || "Package"} | ${p.status} | ${rem} remaining${exp ? " | " + exp : ""}`;
      }).join("\n")
    : "  None";

  // ── Aggregated payment options block ─────────────────────────────────────
  // This is the single place the agent looks to see "how can this customer
  // pay?" — combining their personal credits + the tenant's enabled methods.
  const paymentLines = [];
  for (const m of activeMemberships) {
    const bal = m.minutes_remaining != null && m.minutes_remaining > 0 ? `${m.minutes_remaining} min remaining`
              : m.uses_remaining != null && m.uses_remaining > 0       ? `${m.uses_remaining} uses remaining`
              : null;
    if (!bal) continue;
    paymentLines.push(`  - Membership: ${m.plan_name || "Plan"} (${bal}) — covers services with "membership ok" flag`);
  }
  for (const p of activePackages) {
    const rem = p.remaining_quantity != null ? `${p.remaining_quantity}` : "?";
    paymentLines.push(`  - Prepaid package: ${p.product_name || "Package"} (${rem} remaining)`);
  }
  // Append tenant-level methods
  const tenantPm = formatTenantPaymentMethods(paymentSettings);
  if (tenantPm.trim()) paymentLines.push(tenantPm);

  const paymentOptionsBlock = paymentLines.length
    ? paymentLines.join("\n")
    : "  (No payment methods configured — agent should fall back to asking the customer)";

  return `CUSTOMER: ${profile.name || "Customer"} (${profile.email}${profile.phone ? `, ${profile.phone}` : ""})
- Member since: ${profile.created_at ? new Date(profile.created_at).toLocaleDateString("en-GB") : "N/A"}

UPCOMING BOOKINGS:
${upcomingBlock}

ACTIVE MEMBERSHIPS:
${membershipsBlock}

PREPAID PACKAGES:
${packagesBlock}

PAYMENT OPTIONS FOR THIS CUSTOMER (always present these as choices before confirming a booking — never default):
${paymentOptionsBlock}`;
}

module.exports = { buildVoiceSystemPromptOverride };
