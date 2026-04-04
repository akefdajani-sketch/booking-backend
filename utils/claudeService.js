"use strict";

const Anthropic = require("@anthropic-ai/sdk");

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY automatically

// ── AGENT: Answer tenant/customer questions ──────────────────────────
async function runSupportAgent({ tenantContext, history, message }) {
  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: `You are a helpful booking assistant for ${tenantContext.name}.
Services offered: ${tenantContext.services.map(s => `${s.name} (${s.duration_minutes}min, ${s.price})`).join(", ")}.
Memberships: ${tenantContext.memberships.map(m => m.name).join(", ") || "none"}.
Working hours: ${tenantContext.workingHours || "check the booking page"}.
Answer questions about bookings, availability, services and memberships.
Be concise, friendly, and always guide the customer to book.`,
    messages: [
      ...history, // [{ role: "user", content: "..." }, { role: "assistant", content: "..." }]
      { role: "user", content: message },
    ],
  });

  return response.content[0].text;
}

// ── GENERATOR: Create landing page copy ──────────────────────────────
async function generateLandingCopy({ tenant, services, memberships }) {
  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system:
      "You are a SaaS copywriter. Respond ONLY with valid JSON, no markdown, no explanation.",
    messages: [
      {
        role: "user",
        content: `Generate landing page copy for this business:
Name: ${tenant.name}
Industry: ${tenant.industry || "service business"}
Services: ${services.map((s) => s.name).join(", ")}
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
