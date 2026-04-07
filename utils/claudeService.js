"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const claude = new Anthropic();

// ── Format business context ───────────────────────────────────────────
function buildBusinessContext({ name, services = [], memberships = [], rates = [], workingHours = [], resources = [], staff = [], categories = [], prepaidProducts = [], resourceLinks = [], staffLinks = [] }) {

  const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Build lookup maps
  const catMap = {};
  categories.forEach(c => { catMap[c.id] = c.name; });

  // Build resource map: service_id → [{ id, name }]
  const serviceResourceMap = {};
  resourceLinks.forEach(l => {
    if (!serviceResourceMap[l.service_id]) serviceResourceMap[l.service_id] = [];
    serviceResourceMap[l.service_id].push({ id: l.resource_id, name: l.resource_name });
  });

  // Build staff map: service_id → [{ id, name }]
  const serviceStaffMap = {};
  staffLinks.forEach(l => {
    if (!serviceStaffMap[l.service_id]) serviceStaffMap[l.service_id] = [];
    serviceStaffMap[l.service_id].push({ id: l.staff_id, name: l.staff_name });
  });
  // For dense tenants (many services), omit per-service staff links from services block
  // — staff section below already lists all staff with their service links
  const showStaffPerService = services.length <= 10;

  // Services — group by category when categories exist, include linked resources and staff per service
  const buildServiceLine = (s) => {
    const price = s.price != null
      ? (Number(s.price) === 0 ? "Free" : `${Number(s.price).toFixed(2)} ${s.currency_code || "JD"}`)
      : "price on request";
    const duration   = s.duration_minutes     ? `${s.duration_minutes} min session` : null;
    const interval   = s.slot_interval_minutes ? `${s.slot_interval_minutes} min slot intervals` : null;
    const maxSlots   = s.max_consecutive_slots ? `max ${s.max_consecutive_slots} slots per booking` : null;
    const minSlots   = s.min_consecutive_slots ? `min ${s.min_consecutive_slots} slots` : null;
    const parallel   = s.max_parallel_bookings > 1 ? `${s.max_parallel_bookings} bookings can run simultaneously` : null;
    const allowMem   = s.allow_membership ? "membership credits accepted" : null;
    const desc       = s.description ? `"${s.description}"` : null;

    const linkedResources = serviceResourceMap[s.id];
    const resourcesStr = linkedResources && linkedResources.length > 0
      ? `resources: ${linkedResources.map(r => `${r.name} [resource_id:${r.id}]`).join(", ")}`
      : null;

    const linkedStaff = serviceStaffMap[s.id];
    const staffStr = (showStaffPerService && linkedStaff && linkedStaff.length > 0)
      ? `staff: ${linkedStaff.map(st => `${st.name} [staff_id:${st.id}]`).join(", ")}`
      : null;

    // Compact mode (>10 services): drop verbose details but always keep resources/staff
    const compactMode = services.length > 10;
    const detailFields = compactMode
      ? [duration, price, resourcesStr, staffStr]
      : [duration, interval, price, maxSlots, minSlots, parallel, allowMem, resourcesStr, staffStr, desc];
    const details = detailFields.filter(Boolean).join(" | ");
    return `  - ${s.name} [service_id:${s.id}]: ${details}`;
  };

  let servicesBlock;
  if (services.length === 0) {
    servicesBlock = "  No services configured.";
  } else if (categories.length > 0) {
    // Group services by category
    const grouped = {};
    const uncategorized = [];
    services.forEach(s => {
      const catName = s.category_id && catMap[s.category_id] ? catMap[s.category_id] : null;
      if (catName) {
        if (!grouped[catName]) grouped[catName] = [];
        grouped[catName].push(s);
      } else {
        uncategorized.push(s);
      }
    });
    const sections = Object.entries(grouped).map(([cat, svcs]) =>
      `  [${cat}]\n${svcs.map(buildServiceLine).join("\n")}`
    );
    if (uncategorized.length > 0) {
      sections.push(`  [Other]\n${uncategorized.map(buildServiceLine).join("\n")}`);
    }
    servicesBlock = sections.join("\n\n");
  } else {
    servicesBlock = services.map(buildServiceLine).join("\n");
  }

  // Memberships
  const membershipsBlock = memberships.length > 0
    ? memberships.map((m) => {
        const price    = m.price != null ? `${Number(m.price).toFixed(2)} ${m.currency || "JD"}` : null;
        const billing  = m.billing_type  ? `billed ${m.billing_type}` : null;
        const minutes  = m.included_minutes ? `${m.included_minutes} min included` : null;
        const uses     = m.included_uses    ? `${m.included_uses} uses included` : null;
        const validity = m.validity_days    ? `valid ${m.validity_days} days` : null;
        const desc     = m.description ? `"${m.description}"` : null;
        const details  = [price, billing, minutes, uses, validity, desc].filter(Boolean).join(" | ");
        return `  - ${m.name} [id:${m.id}]: ${details}`;
      }).join("\n")
    : "  No membership plans.";

  // Prepaid packages
  const prepaidBlock = prepaidProducts.length > 0
    ? prepaidProducts.map((p) => {
        const price   = p.price != null ? `${Number(p.price).toFixed(2)} JD` : null;
        const type    = p.product_type || null;
        const sessions= p.session_count  ? `${p.session_count} sessions` : null;
        const minutes = p.minutes_total  ? `${p.minutes_total} min total` : null;
        const credits = p.credit_amount  ? `${p.credit_amount} credits` : null;
        const desc    = p.description    ? `"${p.description}"` : null;
        const details = [price, type, sessions, minutes, credits, desc].filter(Boolean).join(" | ");
        return `  - ${p.name} [id:${p.id}]: ${details}`;
      }).join("\n")
    : "  No prepaid packages.";

  // Rate rules
  const ratesBlock = rates.length > 0
    ? rates.map((r) => {
        const amount = r.amount != null
          ? (r.price_type === "fixed"   ? `fixed ${Number(r.amount).toFixed(2)} ${r.currency_code || "JD"}`
           : r.price_type === "flat_fee"? `flat fee ${Number(r.amount).toFixed(2)} ${r.currency_code || "JD"}`
           : r.price_type === "percent_discount" ? `${r.amount}% discount`
           : `${Number(r.amount).toFixed(2)} ${r.currency_code || "JD"}`)
          : null;
        const days = Array.isArray(r.days_of_week) && r.days_of_week.length > 0
          ? DAY_SHORT.filter((_, i) => r.days_of_week.includes(i)).join(", ")
          : null;
        const time     = r.time_start && r.time_end ? `${r.time_start}–${r.time_end}` : null;
        const dateRange= r.date_start && r.date_end ? `${r.date_start} to ${r.date_end}` : null;
        const durMin   = r.min_duration_mins ? `min ${r.min_duration_mins} min` : null;
        const durMax   = r.max_duration_mins ? `max ${r.max_duration_mins} min` : null;
        const forSvc   = r.service_name ? `for service: ${r.service_name} [id:${r.service_id}]` : "all services";
        const memOnly  = r.membership_name ? `(members only: ${r.membership_name})`
                       : r.require_any_membership ? "(any active membership required)" : null;
        const prepOnly = r.require_any_prepaid ? "(active prepaid package required)" : null;
        const parts    = [amount, forSvc, days, time, dateRange, durMin, durMax, memOnly, prepOnly].filter(Boolean);
        return `  - ${r.name}: ${parts.join(", ")}`;
      }).join("\n")
    : "  No special rate rules.";

  // Working hours
  const hoursBlock = workingHours.length > 0
    ? workingHours
        .filter(h => !h.is_closed)
        .map(h => `  ${DAY[h.day_of_week] || h.day_of_week}: ${h.open_time} – ${h.close_time}`)
        .join("\n") || "  No open days configured."
    : "  Check the booking page for available times.";

  // Resources
  const resourcesBlock = resources.length > 0
    ? resources.map(r => `  - ${r.name} [id:${r.id}]${r.capacity > 1 ? ` (capacity: ${r.capacity})` : ""}`).join("\n")
    : "  No resources listed.";

  // Staff
  const staffBlock = staff.length > 0
    ? staff.map(s => `  - ${s.name} [id:${s.id}]${s.email ? ` (${s.email})` : ""}`).join("\n")
    : "  No staff listed.";

  return `BUSINESS: ${name}

SERVICES (use service id when booking):
${servicesBlock}

MEMBERSHIP PLANS:
${membershipsBlock}

PREPAID PACKAGES:
${prepaidBlock}

RATE RULES (how pricing works — peak hours, member discounts, etc.):
${ratesBlock}

RESOURCES (simulators, rooms, courts, etc.):
${resourcesBlock}

STAFF:
${staffBlock}

WORKING HOURS:
${hoursBlock}`;
}

// ── Format customer context ───────────────────────────────────────────
function buildCustomerContext({ profile, bookings = [], memberships = [], packages = [] }) {
  if (!profile) return null;

  const now = Date.now();

  const upcoming = bookings
    .filter(b => b.start_time && new Date(b.start_time).getTime() >= now && b.status !== "cancelled" && b.service_name)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .slice(0, 10);

  const past = bookings
    .filter(b => b.start_time && new Date(b.start_time).getTime() < now && b.service_name)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    .slice(0, 10);

  const upcomingBlock = upcoming.length > 0
    ? upcoming.map(b => {
        const dt     = new Date(b.start_time).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
        const price  = b.price_amount != null ? ` | ${Number(b.price_amount).toFixed(2)} ${b.currency_code || "JD"}` : "";
        const res    = b.resource_name ? ` | ${b.resource_name}` : "";
        const st     = b.staff_name    ? ` | staff: ${b.staff_name}` : "";
        return `    - [booking id:${b.id}] ${b.service_name || "Service"} | ${dt} | ${b.duration_minutes || "?"}min | status: ${b.status}${price}${res}${st}`;
      }).join("\n")
    : "    None";

  const pastBlock = past.length > 0
    ? past.map(b => {
        const dt = new Date(b.start_time).toLocaleDateString("en-GB", { dateStyle: "medium" });
        return `    - [booking id:${b.id}] ${b.service_name || "Service"} | ${dt} | ${b.status}`;
      }).join("\n")
    : "    None";

  const membershipsBlock = memberships.length > 0
    ? memberships.map(m => {
        const bal     = m.minutes_remaining != null  ? `${m.minutes_remaining} min remaining`
                      : m.uses_remaining != null     ? `${m.uses_remaining} uses remaining` : "balance unknown";
        const expires = m.end_at ? `expires ${new Date(m.end_at).toLocaleDateString("en-GB")}` : null;
        const status  = m.status || "unknown";
        return `    - [membership id:${m.id}] ${m.plan_name || "Plan"} | status: ${status} | ${bal}${expires ? ` | ${expires}` : ""}`;
      }).join("\n")
    : "    None";

  const packagesBlock = packages.length > 0
    ? packages.map(p => {
        const rem     = p.remaining_quantity != null ? `${p.remaining_quantity}/${p.original_quantity || "?"} remaining` : "";
        const expires = p.expires_at ? `expires ${new Date(p.expires_at).toLocaleDateString("en-GB")}` : null;
        return `    - [package id:${p.id}] ${p.product_name || "Package"} | status: ${p.status} | ${rem}${expires ? ` | ${expires}` : ""} (use prepaid_entitlement_id:${p.id} in create_booking to redeem)`;
      }).join("\n")
    : "    None";

  return `CUSTOMER ACCOUNT (${profile.name || "Unknown"} | ${profile.email} | phone: ${profile.phone || "not set"}):
  Member since: ${profile.created_at ? new Date(profile.created_at).toLocaleDateString("en-GB") : "N/A"}

  UPCOMING BOOKINGS:
${upcomingBlock}

  PAST BOOKINGS (recent):
${pastBlock}

  ACTIVE MEMBERSHIPS:
${membershipsBlock}

  PREPAID PACKAGES:
${packagesBlock}`;
}

// ── Build system prompt ───────────────────────────────────────────────
function buildSystemPrompt({ tenantContext, customerData, isSignedIn }) {
  const businessCtx  = buildBusinessContext(tenantContext);
  const customerCtx  = isSignedIn && customerData ? buildCustomerContext(customerData) : null;

  // Inject current date/time in tenant timezone
  const tenantTz = tenantContext.timezone || "Asia/Amman";
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tenantTz }); // YYYY-MM-DD
  const nowStr   = now.toLocaleString("en-GB", { timeZone: tenantTz, dateStyle: "full", timeStyle: "short" });

  // Compute the UTC offset string for this timezone at this moment (e.g. "+03:00", "-05:00")
  // This is injected into prompts so Claude always produces correctly-offset ISO timestamps.
  const tzOffsetStr = (() => {
    try {
      // Use Intl to extract the numeric offset. "longOffset" gives "GMT+3" or "GMT+5:30" etc.
      const offsetPart = new Intl.DateTimeFormat("en", {
        timeZone: tenantTz,
        timeZoneName: "longOffset",
      }).formatToParts(now).find(p => p.type === "timeZoneName")?.value || "GMT+0";
      // offsetPart examples: "GMT+3", "GMT+5:30", "GMT-5", "GMT+0"
      const match = offsetPart.match(/GMT([+\-])(\d+)(?::(\d{2}))?/);
      if (!match) return "+00:00";
      const sign   = match[1];
      const hours  = match[2].padStart(2, "0");
      const mins   = (match[3] || "00").padStart(2, "00");
      return `${sign}${hours}:${mins}`;
    } catch {
      return "+00:00";
    }
  })();

  const exampleDate = todayStr; // use today's date in examples so it's always current-looking

  const customerSection = customerCtx
    ? `\n\n${customerCtx}`
    : "\n\nCUSTOMER: Not signed in — provide general business information only. Do NOT reveal other customers' data.";

  const dateContext = `\n\nCURRENT DATE & TIME: ${nowStr} (today's date for bookings: ${todayStr})\nBusiness timezone: ${tenantTz} (UTC offset: ${tzOffsetStr})\nWhen customer says "tomorrow", use ${new Date(now.getTime() + 86400000).toLocaleDateString("en-CA", { timeZone: tenantTz })}.\nAlways use YYYY-MM-DD format for dates in ACTION calls.`;

  const actionSection = `

ACTIONS YOU CAN PERFORM:
When you need to perform an action, output EXACTLY ONE line in this format (no other text on that line):
ACTION:{"type":"action_name",...params}

Available actions:
1. Check availability:
   ACTION:{"type":"check_availability","service_id":123,"date":"YYYY-MM-DD","resource_id":null,"staff_id":null}
   - IMPORTANT: If the customer mentions a specific resource by name (e.g. "Simulator 3", "Room 2"), look up its resource_id from the SERVICE listing above (each service shows its linked resources with IDs) and include it.
   - If customer mentions a specific staff member, look up their staff_id and include it.
   - If no preference stated, leave resource_id and staff_id as null — the system will auto-select.
   - Always check availability before confirming any time slot.

2. Create booking (only after customer confirms and you have checked availability):
   ACTION:{"type":"create_booking","service_id":123,"start_time":"${exampleDate}T17:00:00${tzOffsetStr}","duration_minutes":120,"resource_id":4,"staff_id":null,"membership_id":null,"prepaid_entitlement_id":null,"slots":2}
   - start_time: ISO 8601 with the business UTC offset — ALWAYS include ${tzOffsetStr} at the end (e.g. ${exampleDate}T17:00:00${tzOffsetStr})
   - CRITICAL: Never omit the timezone offset from start_time. The offset for this business is ${tzOffsetStr}.
   - duration_minutes: total booking duration (slot_interval × number of slots)
   - slots: number of consecutive slots booked
   - resource_id: use the exact resource_id from availability check result, or from service listing
   - membership_id: the [membership id:X] from the customer's active membership if they want to pay with credits
   - prepaid_entitlement_id: the [package id:X] from the customer's package if they want to use prepaid sessions

3. Cancel booking (only for upcoming bookings on the customer's account):
   ACTION:{"type":"cancel_booking","booking_id":456}
   Always confirm details with the customer before cancelling.`;

  return `You are the AI assistant for ${tenantContext.name}. You have full knowledge of this business and access to the signed-in customer's account data.

${businessCtx}${customerSection}${dateContext}${actionSection}

RULES:
- Use ONLY the real data above — never invent prices, services, times, or balances.
- RESOURCES: Each service listing above shows exactly which resources (simulators, rooms, etc.) it can use with their IDs. When a customer requests a specific resource by name, find its resource_id from the service listing and pass it in the ACTION.
- PRICING: Always calculate and quote prices using the rate rules above. Peak hours, member discounts, and time-based pricing all apply. Tell the customer the exact price before confirming.
- MEMBERSHIP: If the customer has an active membership with remaining balance, proactively mention they can use it. Include membership_id in the create_booking ACTION if they want to.
- AVAILABILITY: Always call check_availability before confirming any slot. Pass the specific resource_id if the customer named a resource.
- BOOKING FLOW: 1) Check availability → 2) Show available slots → 3) Confirm details + price with customer → 4) Create booking only after explicit customer confirmation.
- PENDING_BOOKING REQUIRED: Whenever you are presenting booking details and asking "Shall I confirm this booking?", you MUST append this line at the very end of your message (after all other text), on its own line, with no extra characters before or after:
PENDING_BOOKING:{"service_id":SERVICE_ID_NUMBER,"start_time":"YYYY-MM-DDTHH:MM:00${tzOffsetStr}","resource_id":RESOURCE_ID_OR_NULL,"staff_id":STAFF_ID_OR_NULL,"membership_id":MEMBERSHIP_ID_OR_NULL,"duration_minutes":DURATION_NUMBER}
Replace values with exact numbers from the business context. ALWAYS append the timezone offset ${tzOffsetStr} to start_time — never omit it. staff_id is null if no staff is required. membership_id is null if cash payment. This line is parsed by the system and not displayed.
- CONFIRMATION CRITICAL: When the customer says YES to confirming a booking (any of: "yes", "confirm", "go ahead", "book it", "do it", "yes please", "confirm it"), you MUST output ACTION:{...create_booking...} immediately with all booking details from the conversation. Do NOT just say "I'll do it" or "creating now" - output the ACTION line directly.
- PACKAGE PAYMENT: If the customer has a prepaid package with remaining sessions, offer to use it. Include prepaid_entitlement_id from their [package id:X] in the ACTION.
- CANCELLATION: Always show booking details and ask "Shall I go ahead and cancel?" before acting.
- Be concise, warm, and professional. Use bullet points for lists.
- If you don't know something not in the data, say so honestly.
- Always end with a clear next step or question.`;
}

// ── Main agent ────────────────────────────────────────────────────────
async function runSupportAgent({ tenantContext, customerData, isSignedIn, history, message, confirmationMode = false }) {
  // When user is confirming a previously-discussed booking, inject an explicit instruction
  // so Claude reliably outputs ACTION:create_booking with the correct IDs from context.
  const confirmNote = confirmationMode
    ? `

[SYSTEM INSTRUCTION: The customer just confirmed. Output ACTION:{"type":"create_booking","service_id":X,"start_time":"YYYY-MM-DDTHH:MM:00${tzOffsetStr}","duration_minutes":N,"resource_id":X_or_null,"staff_id":X_or_null,"membership_id":X_or_null,"prepaid_entitlement_id":X_or_null,"slots":N} immediately. Use exact IDs from the business context. Use the exact time the customer selected. ALWAYS include the timezone offset ${tzOffsetStr} in start_time. Do NOT ask again.]`
    : "";

  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    system: buildSystemPrompt({ tenantContext, customerData, isSignedIn }),
    messages: [
      ...history,
      { role: "user", content: message + confirmNote },
    ],
  });

  const text = response.content[0].text;

  // Parse ACTION line
  const actionMatch = text.match(/^ACTION:(\{.+\})$/m);
  let action = null;
  if (actionMatch) {
    try { action = JSON.parse(actionMatch[1]); } catch {}
  }

  const cleanText = text.replace(/^ACTION:\{.+\}$/m, "").trim();
  return { reply: cleanText, action };
}

// ── Landing copy generator ────────────────────────────────────────────
async function generateLandingCopy({ tenant, services, memberships }) {
  const serviceList = services
    .map(s => {
      const price = s.price != null
        ? (Number(s.price) === 0 ? "Free" : `${Number(s.price).toFixed(2)} ${s.currency_code || "JD"}`)
        : "price on request";
      return `${s.name} (${s.duration_minutes || "?"}min, ${price})`;
    }).join(", ");

  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: "You are a SaaS copywriter. Respond ONLY with valid JSON, no markdown, no explanation.",
    messages: [{
      role: "user",
      content: `Generate landing page copy for this business:
Name: ${tenant.name}
Industry: service business
Services: ${serviceList}
Memberships available: ${memberships.length > 0 ? "yes" : "no"}

Return this exact JSON shape:
{
  "headline": "...",
  "subheadline": "...",
  "cta_primary": "...",
  "cta_secondary": "...",
  "features": ["...", "...", "..."],
  "about": "..."
}`,
    }],
  });

  return JSON.parse(response.content[0].text);
}

module.exports = { runSupportAgent, generateLandingCopy };
