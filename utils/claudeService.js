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
    // BOOKING-RULES-FIX-1: Make per-service payment eligibility EXPLICIT and
    // unambiguous. Previously this read "membership credits accepted" only
    // when allow_membership was true — leaving the eligibility check up to
    // the LLM to infer, which led to the agent universally offering
    // membership for any booking the customer's credits "could" cover.
    // Now both the positive AND negative cases are stated outright. The
    // PAYMENT ELIGIBILITY rule below references this field directly.
    const paymentField = s.allow_membership
      ? "PAYMENT: membership/prepaid/cash/CliQ/card eligible"
      : "PAYMENT: cash/CliQ/card only — MEMBERSHIP NOT ACCEPTED for this service";
    const desc       = s.description ? `"${s.description}"` : null;

    const linkedResources = serviceResourceMap[s.id];
    const resourcesStr = linkedResources && linkedResources.length > 0
      ? `resources: ${linkedResources.map(r => `${r.name} [resource_id:${r.id}]`).join(", ")}`
      : null;

    const linkedStaff = serviceStaffMap[s.id];
    const staffStr = (showStaffPerService && linkedStaff && linkedStaff.length > 0)
      ? `staff: ${linkedStaff.map(st => `${st.name} [staff_id:${st.id}]`).join(", ")}`
      : null;

    // Compact mode (>10 services): drop verbose details but always keep resources/staff/payment
    const compactMode = services.length > 10;
    const detailFields = compactMode
      ? [duration, price, paymentField, resourcesStr, staffStr]
      : [duration, interval, price, maxSlots, minSlots, parallel, paymentField, resourcesStr, staffStr, desc];
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
function buildCustomerContext({ profile, bookings = [], memberships = [], packages = [] }, services = []) {
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

  // PAYMENT-FILTER-1: Build a quick id→name lookup from services so we can
  // render package eligibility human-readably in the customer context.
  const serviceNameById = new Map(
    (services || []).map(s => [String(s.id), String(s.name || `Service #${s.id}`)])
  );

  const packagesBlock = packages.length > 0
    ? packages.map(p => {
        const rem     = p.remaining_quantity != null ? `${p.remaining_quantity}/${p.original_quantity || "?"} remaining` : "";
        const expires = p.expires_at ? `expires ${new Date(p.expires_at).toLocaleDateString("en-GB")}` : null;
        // PAYMENT-FILTER-1: eligible_service_ids comes back as JSONB. NULL or
        // empty array means the package applies to all services. A non-empty
        // array means it's restricted to those services only.
        const eligibleIds = Array.isArray(p.eligible_service_ids) ? p.eligible_service_ids.map(String) : [];
        let eligibilityStr;
        if (eligibleIds.length === 0) {
          eligibilityStr = "applies to: all services";
        } else {
          const names = eligibleIds.map(id => {
            const nm = serviceNameById.get(id);
            return nm ? `${nm} [service_id:${id}]` : `[service_id:${id}]`;
          });
          eligibilityStr = `ONLY VALID FOR: ${names.join(", ")} — DO NOT offer this package for any other service`;
        }
        return `    - [package id:${p.id}] ${p.product_name || "Package"} | status: ${p.status} | ${rem}${expires ? ` | ${expires}` : ""} | ${eligibilityStr} (use prepaid_entitlement_id:${p.id} in create_booking to redeem)`;
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
  const customerCtx  = isSignedIn && customerData
    ? buildCustomerContext(customerData, tenantContext.services || [])
    : null;

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
   ACTION:{"type":"create_booking","service_id":123,"start_time":"${exampleDate}T17:00:00${tzOffsetStr}","duration_minutes":120,"resource_id":4,"staff_id":null,"payment_method":"cash","membership_id":null,"prepaid_entitlement_id":null,"slots":2}
   - start_time: ISO 8601 with the business UTC offset — ALWAYS include ${tzOffsetStr} at the end (e.g. ${exampleDate}T17:00:00${tzOffsetStr})
   - CRITICAL: Never omit the timezone offset from start_time. The offset for this business is ${tzOffsetStr}.
   - duration_minutes: total booking duration (slot_interval × number of slots)
   - slots: number of consecutive slots booked
   - resource_id: use the exact resource_id from availability check result, or from service listing
   - payment_method: REQUIRED. Which method the customer chose. One of: "membership", "package", "cash", "card", "cliq". See PAYMENT METHOD FIELD rule below.
   - membership_id: the [membership id:X] from the customer's active membership — set ONLY when payment_method="membership"
   - prepaid_entitlement_id: the [package id:X] from the customer's package — set ONLY when payment_method="package"

3. Cancel booking (only for upcoming bookings on the customer's account):
   ACTION:{"type":"cancel_booking","booking_id":456}
   Always confirm details with the customer before cancelling.`;

  return `You are the AI assistant for ${tenantContext.name}. You have full knowledge of this business and access to the signed-in customer's account data.

${businessCtx}${customerSection}${dateContext}${actionSection}

RULES:
- Use ONLY the real data above — never invent prices, services, times, or balances.
- RESOURCES: Each service listing above shows exactly which resources (simulators, rooms, etc.) it can use with their IDs. When a customer requests a specific resource by name, find its resource_id from the service listing and pass it in the ACTION.
- PRICING: Always calculate and quote prices using the rate rules above. Peak hours, member discounts, and time-based pricing all apply. Tell the customer the exact price before confirming.
- CURRENCY FORMATTING:
  Speak prices the way a native customer would say them aloud. NEVER say "JOD", "JD", "Jordanian dinar", or read decimal points ("point five zero").

  Whole dinars (English):
    1.00  → "one dinar"
    2.00  → "two dinars"
    70.00 → "seventy dinars"
    100   → "a hundred dinars"

  Whole dinars (Arabic):
    1.00  → "دينار واحد"
    2.00  → "ديناران"
    3-10  → "ثلاثة دنانير" through "عشرة دنانير"
    11-99 → "أحد عشر ديناراً" (use ديناراً for 11-99)
    100+  → "مئة دينار" (use دينار for 100+)

  Common fractions, English: ".25" → "and a quarter", ".50" → "and a half", ".75" → "and three quarters"
    e.g. 12.50 → "twelve and a half dinars", 17.25 → "seventeen and a quarter dinars"

  Common fractions, Arabic: "ونصف" (and a half), "وربع" (and a quarter), "وثلاثة أرباع" (and three quarters)
    e.g. 12.50 → "اثنا عشر ديناراً ونصف"

  Other amounts — speak in piasters (قروش) since 1 dinar = 100 piasters:
    English: "twelve dinars and forty piasters" for 12.40
    Arabic:  "اثنا عشر ديناراً وأربعون قرشاً" for 12.40

  For very small amounts under one dinar, use piasters alone:
    0.50 → "fifty piasters" / "خمسون قرشاً"
    0.30 → "thirty piasters" / "ثلاثون قرشاً"

  Match the language the customer is speaking. For non-Jordan tenants in other currencies, the same approach applies — speak naturally in that currency, never read digits or currency codes aloud.
- PAYMENT ELIGIBILITY (CRITICAL — READ THE SERVICE'S PAYMENT FIELD):
  Each SERVICE entry above shows a PAYMENT field listing which methods are eligible for that specific service. Examples:
    - "PAYMENT: membership/prepaid/cash/CliQ/card eligible"  → all methods OK
    - "PAYMENT: cash/CliQ/card only — MEMBERSHIP NOT ACCEPTED for this service"  → membership is FORBIDDEN here
  When proposing a booking or asking the customer how to pay, you MUST:
    1. Look up the chosen service's PAYMENT field.
    2. Offer ONLY the methods listed in that field.
    3. If the field says "MEMBERSHIP NOT ACCEPTED", do NOT mention membership as a payment option for that booking — even if the customer has a membership with credits remaining.
    4. Never include membership_id in a create_booking ACTION for a service whose PAYMENT field excludes membership.
  Example: customer asks for "Karaoke" and Karaoke's PAYMENT field says "MEMBERSHIP NOT ACCEPTED" → respond with cash/CliQ/card options only, NEVER offer membership credits.
- MEMBERSHIP USAGE: When the chosen service is membership-eligible AND the customer has an active membership with remaining balance, you MAY proactively mention it as one of the payment choices. Always include all eligible options together so the customer chooses ("Pay with your Pro membership — 240 minutes left — or with cash/CliQ/card?"). Include membership_id in the create_booking ACTION only when the customer explicitly chose membership.
- AVAILABILITY: Always call check_availability before confirming any slot. Pass the specific resource_id if the customer named a resource.
- PAYMENT METHOD FIELD (REQUIRED in PENDING_BOOKING and ACTION):
  Once the customer chooses how to pay, set payment_method to ONE of these exact strings:
    - "membership" → also set membership_id to the [membership id:X] from their account; prepaid_entitlement_id null
    - "package"    → also set prepaid_entitlement_id to the [package id:X]; membership_id null
    - "cash"       → both membership_id and prepaid_entitlement_id null. Booking is confirmed at the venue.
    - "card"       → both ID fields null. NOTE: card payments cannot be completed by chat. The system will return a redirect message asking the customer to use the public Book now button. Speak that message back to the customer; do NOT retry.
    - "cliq"       → same as card.
  Carry the same payment_method through both PENDING_BOOKING and the eventual create_booking ACTION. Never omit it.
- BOOKING FLOW (REQUIRED — NEVER SKIP STEPS):
  Step 1: Check availability via check_availability ACTION.
  Step 2: Show available slots to the customer.
  Step 3: Confirm details + price + payment method with the customer.
  Step 4: Output PENDING_BOOKING line — ALWAYS, BEFORE asking "Shall I confirm?". The frontend renders PENDING_BOOKING as a summary card with a Confirm button. WITHOUT the PENDING_BOOKING line, the customer has no summary to review and the booking experience breaks. ALWAYS emit it on the turn where you propose the booking.
  Step 5: Only AFTER the customer confirms (any of: "yes", "yeah", "confirmed", "confirm", "go ahead", "book it", "do it", "yes please", "make it", and Arabic equivalents like "نعم", "أكد", "احجز", "تمام"), output the ACTION:{create_booking,...} line. The system writes the booking to the database. WITHOUT the ACTION line, no booking is saved.

  TWO LINES, TWO TURNS:
    Turn N (proposing):     Your message + PENDING_BOOKING:{...}
    Turn N+1 (confirming):  ACTION:{"type":"create_booking",...} + spoken acknowledgement

  Never skip the PENDING_BOOKING summary on turn N.
  Never skip the ACTION on turn N+1.
  Both are mandatory parts of every booking.
- PENDING_BOOKING FORMAT: When emitting the PENDING_BOOKING line on turn N, append it at the very end of your message, on its own line, with no extra characters before or after:
PENDING_BOOKING:{"service_id":SERVICE_ID_NUMBER,"start_time":"YYYY-MM-DDTHH:MM:00${tzOffsetStr}","resource_id":RESOURCE_ID_OR_NULL,"staff_id":STAFF_ID_OR_NULL,"payment_method":"PAYMENT_METHOD_STRING","membership_id":MEMBERSHIP_ID_OR_NULL,"prepaid_entitlement_id":PREPAID_ID_OR_NULL,"duration_minutes":DURATION_NUMBER}
Replace values with exact numbers from the business context. ALWAYS append the timezone offset ${tzOffsetStr} to start_time — never omit it. staff_id is null if no staff is required. payment_method is required and must match the customer's choice. membership_id is non-null ONLY when payment_method="membership"; prepaid_entitlement_id is non-null ONLY when payment_method="package". This line is parsed by the system and not displayed.
- PACKAGE PAYMENT — STRICT ELIGIBILITY:
  Each prepaid package the customer holds shows either "applies to: all services" OR "ONLY VALID FOR: <service list>". This is the customer-side restriction.

  When proposing a payment method, you MUST:
    1. Check the package's eligibility line.
    2. If it says "ONLY VALID FOR: ...", offer the package as a payment option ONLY for the services listed there. Never offer it for other services even if the service's PAYMENT field includes "prepaid".
    3. If it says "applies to: all services", you may offer it for any service whose PAYMENT field includes "prepaid".

  Example: customer has "Lesson Pack [package id:9] | ONLY VALID FOR: Group Lesson [service_id:5]". Customer wants to book Sim Bay 1 [service_id:1]. → DO NOT mention the Lesson Pack as a payment option, even though it has remaining sessions. The Lesson Pack is restricted to Group Lesson only.

  Include prepaid_entitlement_id from [package id:X] in the ACTION only when (a) the customer explicitly chose that package, AND (b) the package is eligible for the chosen service.
- CANCELLATION: Always show booking details and ask "Shall I go ahead and cancel?" before acting.
- Be concise, warm, and professional. Use bullet points for lists.
- If you don't know something not in the data, say so honestly.
- Always end with a clear next step or question.`;
}

// ── Main agent ────────────────────────────────────────────────────────
async function runSupportAgent({ tenantContext, customerData, isSignedIn, history, message, confirmationMode = false }) {
  // Compute tz offset here (same logic as buildSystemPrompt) — tzOffsetStr only
  // exists in that function's scope and cannot be referenced here directly.
  const _tz = tenantContext.timezone || "Asia/Amman";
  const _tzOffsetStr = (() => {
    try {
      const offsetPart = new Intl.DateTimeFormat("en", {
        timeZone: _tz, timeZoneName: "longOffset",
      }).formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value || "GMT+0";
      const match = offsetPart.match(/GMT([+\-])(\d+)(?::(\d{2}))?/);
      if (!match) return "+00:00";
      return `${match[1]}${match[2].padStart(2, "0")}:${(match[3] || "00").padStart(2, "0")}`;
    } catch { return "+00:00"; }
  })();

  // When user is confirming a previously-discussed booking, inject an explicit instruction
  // so Claude reliably outputs ACTION:create_booking with the correct IDs from context.
  //
  // BOOKING-DROP-FIX-1.1 (May 4, 2026): the original "ACTION must be FIRST LINE"
  // wording was too aggressive — Claude started emitting ACTION on turn 1 too,
  // skipping the PENDING_BOOKING summary card entirely. This restored wording
  // requires ACTION but does NOT force ordering, leaving room for Claude to
  // include a brief acknowledgement and the ACTION line in either order.
  const confirmNote = confirmationMode
    ? `

[SYSTEM INSTRUCTION — BOOKING CONFIRMATION:
The customer just confirmed an existing pending booking. Output an ACTION line in your response, formatted exactly:

ACTION:{"type":"create_booking","service_id":X,"start_time":"YYYY-MM-DDTHH:MM:00${_tzOffsetStr}","duration_minutes":N,"resource_id":X_or_null,"staff_id":X_or_null,"payment_method":"<membership|package|cash|card|cliq>","membership_id":X_or_null,"prepaid_entitlement_id":X_or_null,"slots":N}

Use exact IDs from the business context. Use the exact time the customer selected. Use the payment_method THEY chose earlier in this conversation. ALWAYS include the timezone offset ${_tzOffsetStr} in start_time.

Without the ACTION line the booking will NOT be saved. Do NOT output a PENDING_BOOKING line — only the ACTION line. Do NOT ask again.]`
    : "";

  // VOICE-PERF-1: Build the system prompt once and reuse via Anthropic
  // prompt caching. The cache_control marker tells the API to cache this
  // entire system block; subsequent turns within ~5 min for the same
  // tenant+customer get a 90% reduction in tokenization cost and a
  // ~1.5-2.5s latency drop. Voice sessions are <5 min so cache hit rate
  // is high in practice.
  const systemPromptText = buildSystemPrompt({ tenantContext, customerData, isSignedIn });

  const claudeRequest = {
    model: "claude-sonnet-4-6",
    // VOICE-PERF-1: Was 3000. Booking replies are short; cap reduces TTFT and
    // prevents runaway responses that bog down TTS.
    max_tokens: 1000,
    // VOICE-PERF-1: Was unset (default ~1.0). Booking reasoning benefits from
    // determinism — pairs with the strict PAYMENT METHOD FIELD rule.
    temperature: 0.3,
    system: [
      {
        type: "text",
        text: systemPromptText,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      ...history,
      { role: "user", content: message + confirmNote },
    ],
  };

  const response = await claude.messages.create(claudeRequest);

  const text = response.content[0].text;

  // BOOKING-DROP-FIX-1: Looser ACTION regex.
  // Original required ACTION at start of line with no space after colon. In
  // practice Claude occasionally emits "ACTION: {…}" (one space) or wraps the
  // line. Allow optional whitespace after the colon and don't require $ end-
  // of-line — JSON ends at the closing brace anyway. Multi-line flag stays.
  function parseActionFromText(t) {
    if (!t) return null;
    const m = t.match(/^ACTION:\s*(\{[\s\S]+?\})\s*$/m);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch (e) {
      console.warn("[claudeService] ACTION JSON parse failed:", m[1].slice(0, 200), "err:", e.message);
      return null;
    }
  }

  let action = parseActionFromText(text);

  // BOOKING-DROP-FIX-1: One-shot retry on missing ACTION in confirmation mode.
  // We expect Claude to fire create_booking when the user just said "yes".
  // If it didn't (or output broken JSON), nudge it once with an explicit
  // correction instead of silently dropping. The corrective prompt is short
  // and forceful: ACTION line ONLY, no prose. Cuts retry-failure rate further.
  if (confirmationMode && !action) {
    console.warn("[claudeService] confirmationMode=true but no valid ACTION parsed — issuing one-shot correction");
    try {
      const retry = await claude.messages.create({
        ...claudeRequest,
        max_tokens: 400,
        messages: [
          ...history,
          { role: "user",      content: message + confirmNote },
          { role: "assistant", content: text },
          { role: "user",      content: '[CORRECTION: Your previous reply confirmed the booking but did not emit the ACTION:{...} line, so the booking was NOT saved. Output ONLY the ACTION:{"type":"create_booking",...} line now — no prose, no acknowledgement, no prefix, no markdown. Just one line beginning with ACTION:{ and ending with }. Include payment_method. The system will use this line to write the booking to the database.]' },
        ],
      });
      const retryText = retry.content[0].text;
      action = parseActionFromText(retryText);
      if (action) {
        console.log("[claudeService] retry succeeded — got valid ACTION");
      } else {
        console.warn("[claudeService] retry produced no ACTION line either");
      }
    } catch (e) {
      console.error("[claudeService] retry call threw:", e.message);
    }
  }

  // BOOKING-DROP-FIX-1.1 (May 4, 2026): The aggressive safety-net override
  // (which replaced Claude's reply with a generic "could you confirm again?"
  // recovery message whenever confirmationMode=true and no action was parsed)
  // has been REMOVED. It was destroying valid turn-1 conversations where
  // confirmationMode was triggered by an ambiguous opener like "ok book sim 3"
  // — there was no actual pending booking to act on, so the override was just
  // garbling the conversation. The retry above is sufficient insurance; in the
  // rare residual case where retry also fails, returning Claude's reply
  // verbatim is preferable to a confusing forced-recovery that may not match
  // the actual conversational state.
  const cleanText = text.replace(/^ACTION:\s*\{[\s\S]+?\}\s*$/m, "").trim();
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
