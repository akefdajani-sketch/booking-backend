"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const claude = new Anthropic();

// ── Build business context (always shown) ────────────────────────────
function buildBusinessContext({ name, services = [], memberships = [], rates = [], workingHours }) {
  const servicesBlock = services.length > 0
    ? services.map((s) => {
        const price = s.price != null ? (s.price === 0 ? "Free" : `${s.price} ${s.currency || "JD"}`) : "contact for pricing";
        const duration = s.duration_minutes ? `${s.duration_minutes} min` : null;
        const slots = s.max_consecutive_slots ? `up to ${s.max_consecutive_slots} slots` : null;
        const parallel = s.max_parallel_bookings > 1 ? `${s.max_parallel_bookings} simultaneous bookings` : null;
        const desc = s.description ? `"${s.description}"` : null;
        return `  - ${s.name} [id:${s.id}]: ${[duration, price, slots, parallel, desc].filter(Boolean).join(" | ")}`;
      }).join("\n")
    : "  No services listed.";

  const membershipsBlock = memberships.length > 0
    ? memberships.map((m) => {
        const price = m.price != null ? `${m.price} ${m.currency || "JD"}` : null;
        const billing = m.billing_type ? `billed ${m.billing_type}` : null;
        const minutes = m.included_minutes ? `${m.included_minutes} min included` : null;
        const uses = m.included_uses ? `${m.included_uses} uses included` : null;
        const validity = m.validity_days ? `valid ${m.validity_days} days` : null;
        const desc = m.description ? `"${m.description}"` : null;
        return `  - ${m.name} [id:${m.id}]: ${[price, billing, minutes, uses, validity, desc].filter(Boolean).join(" | ")}`;
      }).join("\n")
    : "  No membership plans.";

  const ratesBlock = rates.length > 0
    ? rates.map((r) => {
        const amount = r.amount != null
          ? r.price_type === "percent_discount" ? `${r.amount}% discount`
          : r.price_type === "fixed_override" ? `fixed ${r.amount} ${r.currency_code || "JD"}`
          : r.price_type === "flat_fee" ? `flat fee ${r.amount} ${r.currency_code || "JD"}`
          : `${r.amount} ${r.currency_code || "JD"}`
          : null;
        const days = Array.isArray(r.days_of_week) && r.days_of_week.length > 0
          ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].filter((_,i) => r.days_of_week.includes(i)).join(", ")
          : null;
        const time = r.time_start && r.time_end ? `${r.time_start}–${r.time_end}` : null;
        const forService = r.service_name ? `for ${r.service_name}` : null;
        const memberOnly = r.membership_name ? `(${r.membership_name} members only)` : r.require_any_membership ? "(members only)" : null;
        return `  - ${r.name}: ${[amount, forService, days, time, memberOnly].filter(Boolean).join(", ")}`;
      }).join("\n")
    : "  No special rate rules.";

  const hoursBlock = workingHours
    ? Array.isArray(workingHours)
      ? workingHours.filter(h => h.is_open !== false)
          .map(h => `  ${h.day_of_week || h.day}: ${h.open_time || h.from} – ${h.close_time || h.to}`)
          .join("\n")
      : String(workingHours)
    : "  Check booking page for availability.";

  return `BUSINESS: ${name}

SERVICES:
${servicesBlock}

MEMBERSHIP PLANS:
${membershipsBlock}

RATE RULES (peak/off-peak/member pricing):
${ratesBlock}

WORKING HOURS:
${hoursBlock}`;
}

// ── Build customer context (only when signed in) ─────────────────────
function buildCustomerContext({ profile, bookings = [], memberships = [], packages = [] }) {
  if (!profile) return null;

  const profileBlock = `  Name: ${profile.name || "N/A"}
  Email: ${profile.email || "N/A"}
  Phone: ${profile.phone || "N/A"}
  Member since: ${profile.created_at ? new Date(profile.created_at).toLocaleDateString() : "N/A"}`;

  const now = Date.now();

  const upcomingBookings = bookings
    .filter(b => new Date(b.start_time).getTime() >= now && b.status !== "cancelled")
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .slice(0, 10);

  const pastBookings = bookings
    .filter(b => new Date(b.start_time).getTime() < now)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    .slice(0, 10);

  const bookingsBlock = `  Upcoming (${upcomingBookings.length}):
${upcomingBookings.length > 0
  ? upcomingBookings.map(b =>
      `    - [id:${b.id}] ${b.service_name || "Service"} on ${new Date(b.start_time).toLocaleString()} | ${b.duration_minutes || "?"}min | status: ${b.status} | ${b.price_amount != null ? `${b.price_amount} ${b.currency_code || "JD"}` : "no charge"}`
    ).join("\n")
  : "    None"}

  Recent past (${pastBookings.length}):
${pastBookings.length > 0
  ? pastBookings.map(b =>
      `    - [id:${b.id}] ${b.service_name || "Service"} on ${new Date(b.start_time).toLocaleDateString()} | ${b.status}`
    ).join("\n")
  : "    None"}`;

  const membershipsBlock = memberships.length > 0
    ? memberships.map(m => {
        const balance = m.minutes_remaining != null
          ? `${m.minutes_remaining} min remaining`
          : m.uses_remaining != null
          ? `${m.uses_remaining} uses remaining`
          : null;
        const expires = m.end_at ? `expires ${new Date(m.end_at).toLocaleDateString()}` : null;
        return `    - [id:${m.id}] ${m.plan_name || "Plan"} | status: ${m.status} | ${[balance, expires].filter(Boolean).join(" | ")}`;
      }).join("\n")
    : "    None";

  const packagesBlock = packages.length > 0
    ? packages.map(p =>
        `    - [id:${p.id}] ${p.product_name || "Package"} | ${p.remaining_quantity ?? "?"} remaining | status: ${p.status} | expires: ${p.expires_at ? new Date(p.expires_at).toLocaleDateString() : "N/A"}`
      ).join("\n")
    : "    None";

  return `CUSTOMER PROFILE:
${profileBlock}

CUSTOMER BOOKINGS:
${bookingsBlock}

CUSTOMER MEMBERSHIPS:
${membershipsBlock}

CUSTOMER PACKAGES / PREPAID:
${packagesBlock}`;
}

// ── Build the full system prompt ──────────────────────────────────────
function buildSystemPrompt({ tenantContext, customerData, isSignedIn }) {
  const businessContext = buildBusinessContext(tenantContext);
  const customerContext = isSignedIn && customerData ? buildCustomerContext(customerData) : null;

  const customerSection = customerContext
    ? `\n\n${customerContext}`
    : "\n\nCUSTOMER: Not signed in. Provide general information only.";

  const actionSection = isSignedIn ? `
ACTIONS YOU CAN TAKE:
When the customer requests an action, respond with a JSON block in this format on its own line:
ACTION:{"type":"cancel_booking","booking_id":123}
ACTION:{"type":"check_balance"}
ACTION:{"type":"view_bookings"}

Supported actions:
- cancel_booking: when customer wants to cancel a specific upcoming booking
- check_balance: when customer asks about their membership/package balance
- view_bookings: when customer wants to see their upcoming bookings` : "";

  return `You are the AI assistant for ${tenantContext.name}.
You have full knowledge of this business and the signed-in customer's account.

${businessContext}${customerSection}${actionSection}

RULES:
- Use real data from above. Never invent prices, services, or customer data.
- For pricing questions, reference exact amounts and applicable rate rules.
- For customer questions (balance, bookings, history), use their actual data above.
- When taking actions, confirm with the customer first, then output the ACTION line.
- Be concise, warm, and professional.
- For anonymous users, answer general questions only — never reveal other customers' data.
- End responses with a helpful next step or CTA.`;
}

// ── Main agent function ───────────────────────────────────────────────
async function runSupportAgent({ tenantContext, customerData, isSignedIn, history, message }) {
  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: buildSystemPrompt({ tenantContext, customerData, isSignedIn }),
    messages: [
      ...history,
      { role: "user", content: message },
    ],
  });

  const text = response.content[0].text;

  // Parse any action the AI wants to take
  const actionMatch = text.match(/^ACTION:(\{.+\})$/m);
  const action = actionMatch ? JSON.parse(actionMatch[1]) : null;

  // Return clean text (without the ACTION line) + parsed action
  const cleanText = text.replace(/^ACTION:\{.+\}$/m, "").trim();

  return { reply: cleanText, action };
}

// ── Landing page copy generator ───────────────────────────────────────
async function generateLandingCopy({ tenant, services, memberships }) {
  const serviceList = services
    .map(s => {
      const price = s.price != null ? (s.price === 0 ? "Free" : `${s.price} ${s.currency || "JD"}`) : "contact for pricing";
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
Industry: ${tenant.industry || "service business"}
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
