"use strict";

const Anthropic = require("@anthropic-ai/sdk");

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY automatically

// ── Build a rich, structured system prompt from real DB data ──────────
function buildSystemPrompt(tenantContext) {
  const { name, services = [], memberships = [], rates = [], workingHours } = tenantContext;

  // Format services with all available detail
  const servicesBlock = services.length > 0
    ? services.map((s) => {
        const price = s.price != null
          ? (s.price === 0 ? "Free" : `${s.price} ${s.currency || "JD"}`)
          : "contact for pricing";
        const duration = s.duration_minutes ? `${s.duration_minutes} min` : null;
        const slots = s.max_consecutive_slots ? `up to ${s.max_consecutive_slots} consecutive slots` : null;
        const parallel = s.max_parallel_bookings > 1 ? `${s.max_parallel_bookings} people can book simultaneously` : null;
        const desc = s.description ? `"${s.description}"` : null;
        const details = [duration, price, slots, parallel, desc].filter(Boolean).join(" | ");
        return `  - ${s.name}: ${details}`;
      }).join("\n")
    : "  No services listed yet.";

  // Format memberships with full detail
  const membershipsBlock = memberships.length > 0
    ? memberships.map((m) => {
        const price = m.price != null ? `${m.price} ${m.currency || "JD"}` : null;
        const billing = m.billing_type ? `billed ${m.billing_type}` : null;
        const minutes = m.included_minutes ? `${m.included_minutes} min included` : null;
        const uses = m.included_uses ? `${m.included_uses} uses included` : null;
        const validity = m.validity_days ? `valid ${m.validity_days} days` : null;
        const desc = m.description ? `"${m.description}"` : null;
        const details = [price, billing, minutes, uses, validity, desc].filter(Boolean).join(" | ");
        return `  - ${m.name}: ${details}`;
      }).join("\n")
    : "  No membership plans available.";

  // Format rate rules — these are special pricing overrides (peak, off-peak, member rates etc.)
  const ratesBlock = rates.length > 0
    ? rates.map((r) => {
        const parts = [];
        const amount = r.amount != null
          ? (r.price_type === "percent_discount"
              ? `${r.amount}% discount`
              : r.price_type === "fixed_override"
              ? `fixed price ${r.amount} ${r.currency_code || "JD"}`
              : r.price_type === "flat_fee"
              ? `flat fee ${r.amount} ${r.currency_code || "JD"}`
              : `${r.amount} ${r.currency_code || "JD"}`)
          : null;
        if (amount) parts.push(amount);
        if (r.service_name) parts.push(`for ${r.service_name}`);
        if (r.days_of_week) {
          const days = Array.isArray(r.days_of_week) ? r.days_of_week : [];
          const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
          if (days.length > 0) parts.push(`on ${days.map(d => dayNames[d] || d).join(", ")}`);
        }
        if (r.time_start && r.time_end) parts.push(`${r.time_start}–${r.time_end}`);
        if (r.date_start && r.date_end) parts.push(`from ${r.date_start} to ${r.date_end}`);
        if (r.membership_name) parts.push(`(members: ${r.membership_name} only)`);
        if (r.require_any_membership) parts.push("(any active membership required)");
        return `  - ${r.name}: ${parts.join(", ")}`;
      }).join("\n")
    : "  No special rate rules configured.";

  // Format working hours
  const hoursBlock = workingHours
    ? (Array.isArray(workingHours)
        ? workingHours
            .filter((h) => h.is_open !== false)
            .map((h) => `  ${h.day_of_week || h.day}: ${h.open_time || h.from} - ${h.close_time || h.to}`)
            .join("\n")
        : String(workingHours))
    : "  Check the booking page for available slots.";

  return `You are the AI assistant for ${name}, a booking-based business.
Your job is to help customers understand services, pricing, memberships, and how to book.

SERVICES:
${servicesBlock}

MEMBERSHIP PLANS:
${membershipsBlock}

PRICING & RATE RULES (special rates, peak hours, member discounts etc.):
${ratesBlock}

WORKING HOURS:
${hoursBlock}

INSTRUCTIONS:
- Always answer based on the real data above. Never invent services, prices, or rules.
- If a customer asks about pricing, give the exact price from the data above including any applicable rate rules.
- If a customer asks how long a session is, give the exact duration.
- If a customer asks about memberships, explain what is included clearly.
- If there are special rates (peak, off-peak, member discounts), mention them when relevant.
- Keep replies concise and friendly. Use bullet points for lists.
- Always end with a nudge to book, e.g. "Ready to book? Tap the Book tab above."
- If you don't know something (e.g. real-time availability), say so and direct them to book directly.
- Do not make up information that is not in the data above.`;
}

// ── AGENT: Answer tenant/customer questions ───────────────────────────
async function runSupportAgent({ tenantContext, history, message }) {
  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: buildSystemPrompt(tenantContext),
    messages: [
      ...history,
      { role: "user", content: message },
    ],
  });

  return response.content[0].text;
}

// ── GENERATOR: Create landing page copy ──────────────────────────────
async function generateLandingCopy({ tenant, services, memberships }) {
  const serviceList = services
    .map((s) => {
      const price = s.price != null
        ? (s.price === 0 ? "Free" : `${s.price} ${s.currency || "JD"}`)
        : "contact for pricing";
      return `${s.name} (${s.duration_minutes || "?"}min, ${price})`;
    })
    .join(", ");

  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: "You are a SaaS copywriter. Respond ONLY with valid JSON, no markdown, no explanation.",
    messages: [
      {
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
      },
    ],
  });

  return JSON.parse(response.content[0].text);
}

module.exports = { runSupportAgent, generateLandingCopy };
