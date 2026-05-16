'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// utils/bookingBrain.js — Phase 2.1
//
// Decision-only brain for the booking voice/chat agent. Splits the "what to
// do" decision out of the single mixed brain+persona prompt in
// utils/claudeService.js so we can:
//   (1) shrink the prompt the LLM has to reason against,
//   (2) constrain output to STRUCTURED JSON (no fabricated prose, no
//       fabricated slot times, no fabricated currency strings),
//   (3) apply STRUCTURAL FALLBACKS that catch LLM mistakes on the four
//       known production bugs — belt-and-suspenders over prompt rules.
//
// The brain is UNWIRED in 2.1 — nothing in production calls it. Orchestrator
// wire-up happens in Phase 2.3. Phase 2.2 builds the persona that renders
// the brain's structured output into prose for the customer.
//
// ARCHITECTURAL PRINCIPLE — STRUCTURAL FALLBACKS:
//   Every brain prompt rule for a production bug has a structural fallback
//   in the parsing/post-processing layer. Prompt rules are guidance;
//   structural defenses are guarantees.
//     • Bug A (availability overflow)  — STRUCTURAL: no slot output channel
//     • Bug B (concurrent conflict)    — STRUCTURAL: overlap check vs UPCOMING
//     • Bug C (fabricated slots)       — STRUCTURAL: same as A
//     • Bug D (no personalization)     — DATA: personalization signals
//                                        always-typed on every return
//   plus PAYMENT ELIGIBILITY and PACKAGE ELIGIBILITY structural rewrites.
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');

const BRAIN_MODEL = 'claude-sonnet-4-6';
const BRAIN_MAX_TOKENS = 400;
const BRAIN_TEMPERATURE = 0;

const claude = new Anthropic();

// ─────────────────────────────────────────────────────────────────────────────
// Personalization — pure JS, no Claude call.
// Returns an always-typed object (all fields present). Consumers do not need
// to null-check the wrapper.
// ─────────────────────────────────────────────────────────────────────────────
function computePersonalization(customerData) {
  const defaults = {
    usualResourceId: null,
    usualResourceName: null,
    lastBookingId: null,
    lastBookingServiceId: null,
    bookingsCountLast90Days: 0,
  };
  if (!customerData || !Array.isArray(customerData.bookings)) return defaults;

  const now = Date.now();
  const ninetyDaysAgoMs = now - 90 * 24 * 60 * 60 * 1000;

  const past = customerData.bookings
    .filter((b) => b && b.start_time && new Date(b.start_time).getTime() < now)
    .filter((b) => b.status !== 'cancelled')
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

  const recentPast = past.filter(
    (b) => new Date(b.start_time).getTime() >= ninetyDaysAgoMs,
  );

  // Frequency-count resources across recent past
  const counts = new Map();
  for (const b of recentPast) {
    if (b.resource_id != null) {
      counts.set(b.resource_id, (counts.get(b.resource_id) || 0) + 1);
    }
  }
  let topId = null;
  let topName = null;
  let topCount = 0;
  for (const [id, count] of counts.entries()) {
    if (count > topCount) {
      topCount = count;
      topId = id;
      const sample = recentPast.find((b) => b.resource_id === id);
      topName = sample?.resource_name || null;
    }
  }
  // Only surface as "usual" if 3+ sessions — same threshold as
  // claudeService.buildCustomerContext (PATTERNS DETECTED block).
  const haveUsual = topCount >= 3;

  const last = past[0] || null;

  return {
    usualResourceId: haveUsual ? topId : null,
    usualResourceName: haveUsual ? topName : null,
    lastBookingId: last?.id || null,
    lastBookingServiceId: last?.service_id || null,
    bookingsCountLast90Days: recentPast.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output parser — robust to prose-wrapped JSON, markdown fences, and a
// leading "Sure! Here's the JSON:" preamble. Returns null if no parseable
// JSON object is found.
// ─────────────────────────────────────────────────────────────────────────────
function parseBrainOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const trimmed = rawText.trim();

  // Common case: temperature=0 + strict prompt returns bare JSON.
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) { /* fall through */ }

  // Markdown code-fence block: ```json\n{...}\n``` or ```\n{...}\n```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1].trim());
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) { /* fall through */ }
  }

  // First { ... } block — covers "Here is the JSON: {...}" preambles.
  const braceMatch = trimmed.match(/\{[\s\S]+\}/);
  if (braceMatch) {
    try {
      const obj = JSON.parse(braceMatch[0]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) { /* fall through */ }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural fallbacks — applied AFTER the LLM returns. Catches the bugs at
// the parse layer so we are not solely dependent on prompt rules holding.
// ─────────────────────────────────────────────────────────────────────────────
function applyStructuralFallbacks({ parsed, tenantContext, customerData }) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  // ─────────────────────────────────────────────────────────────────
  // CONFLICT CHECK FALLBACK (Bug B)
  // If create_booking proposes a time overlapping an UPCOMING booking
  // in the customer's account, rewrite to an answer explaining the
  // conflict.
  // ─────────────────────────────────────────────────────────────────
  if (parsed.intent === 'create_booking' && parsed.action) {
    const conflict = detectUpcomingConflict({ action: parsed.action, customerData });
    if (conflict) {
      return {
        intent: 'answer',
        action: null,
        answer: {
          kind: 'conflict',
          payload: {
            conflictingBookingId: conflict.id,
            conflictingStartTime: conflict.start_time,
            conflictingDurationMinutes: conflict.duration_minutes,
            conflictingServiceName: conflict.service_name || null,
            proposedStartTime: parsed.action.start_time,
            proposedDurationMinutes: parsed.action.duration_minutes,
          },
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // PAYMENT ELIGIBILITY FALLBACK
  // If payment_method=membership for a service with allow_membership=false,
  // rewrite to clarify so persona can ask for a different method.
  // ─────────────────────────────────────────────────────────────────
  if (
    parsed.intent === 'create_booking' &&
    parsed.action &&
    parsed.action.payment_method === 'membership'
  ) {
    const svc = findService(tenantContext, parsed.action.service_id);
    if (svc && svc.allow_membership === false) {
      return {
        intent: 'clarify',
        action: null,
        answer: {
          kind: 'payment_method_invalid',
          payload: {
            service_id: parsed.action.service_id,
            service_name: svc.name || null,
            payment_method: 'membership',
            reason: 'service_excludes_membership',
          },
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // PACKAGE ELIGIBILITY FALLBACK
  // If prepaid_entitlement_id refers to a package whose eligible_service_ids
  // do not include the chosen service, rewrite to clarify.
  // ─────────────────────────────────────────────────────────────────
  if (
    parsed.intent === 'create_booking' &&
    parsed.action &&
    parsed.action.prepaid_entitlement_id
  ) {
    const pkg = findPackage(customerData, parsed.action.prepaid_entitlement_id);
    if (
      pkg &&
      Array.isArray(pkg.eligible_service_ids) &&
      pkg.eligible_service_ids.length > 0
    ) {
      const eligibleIds = pkg.eligible_service_ids.map(Number);
      if (!eligibleIds.includes(Number(parsed.action.service_id))) {
        return {
          intent: 'clarify',
          action: null,
          answer: {
            kind: 'package_ineligible',
            payload: {
              service_id: parsed.action.service_id,
              package_id: parsed.action.prepaid_entitlement_id,
              package_name: pkg.product_name || null,
              eligible_service_ids: eligibleIds,
            },
          },
        };
      }
    }
  }

  return parsed;
}

function detectUpcomingConflict({ action, customerData }) {
  if (!action || !action.start_time || !action.duration_minutes) return null;
  if (!customerData || !Array.isArray(customerData.bookings)) return null;

  const proposedStart = new Date(action.start_time).getTime();
  if (!Number.isFinite(proposedStart)) return null;
  const proposedEnd = proposedStart + Number(action.duration_minutes) * 60 * 1000;

  const now = Date.now();
  for (const b of customerData.bookings) {
    if (!b || !b.start_time) continue;
    if (b.status === 'cancelled') continue;
    const bStart = new Date(b.start_time).getTime();
    if (!Number.isFinite(bStart)) continue;
    if (bStart < now) continue; // past booking — does not conflict with a new one
    const bDur = Number(b.duration_minutes) || 60;
    const bEnd = bStart + bDur * 60 * 1000;
    // overlap iff proposed.start < booking.end AND proposed.end > booking.start
    if (proposedStart < bEnd && proposedEnd > bStart) {
      return b;
    }
  }
  return null;
}

function findService(tenantContext, serviceId) {
  if (!tenantContext || !Array.isArray(tenantContext.services)) return null;
  const id = Number(serviceId);
  return tenantContext.services.find((s) => Number(s.id) === id) || null;
}

function findPackage(customerData, packageId) {
  if (!customerData || !Array.isArray(customerData.packages)) return null;
  const id = Number(packageId);
  return customerData.packages.find((p) => Number(p.id) === id) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Brain prompt builder — strict JSON-output schema, no persona rules.
// ─────────────────────────────────────────────────────────────────────────────
function buildBrainPrompt({ tenantContext, customerData, isSignedIn }) {
  const tenantTz = tenantContext?.timezone || 'Asia/Amman';
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tenantTz });
  const tomorrowStr = new Date(now.getTime() + 86400000)
    .toLocaleDateString('en-CA', { timeZone: tenantTz });

  // UTC offset for create_booking start_time format
  let tzOffsetStr;
  try {
    const offsetPart = new Intl.DateTimeFormat('en', {
      timeZone: tenantTz, timeZoneName: 'longOffset',
    }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';
    const m = offsetPart.match(/GMT([+\-])(\d+)(?::(\d{2}))?/);
    tzOffsetStr = m ? `${m[1]}${m[2].padStart(2, '0')}:${(m[3] || '00').padStart(2, '0')}` : '+00:00';
  } catch (_) { tzOffsetStr = '+00:00'; }

  const businessBlock = buildBrainBusinessContext(tenantContext);
  const customerBlock = isSignedIn && customerData
    ? buildBrainCustomerContext(customerData, tenantTz)
    : 'CUSTOMER: not signed in';

  return `You are the DECISION-ONLY brain of a booking agent. Output a SINGLE JSON object — no prose, no markdown fences, no preamble, no explanation. Never produce currency speech, language matching, tone, or PENDING_BOOKING wire format — those are handled by a separate persona layer.

OUTPUT SCHEMA (return EXACTLY this shape):
{
  "intent": "check_availability" | "create_booking" | "cancel_booking" | "answer" | "clarify",
  "action": null OR action object (see ACTIONS below),
  "answer": null OR { "kind": <string>, "payload": <object> }
}

INTENT RULES:
- "check_availability" — action MUST be the availability params; answer MUST be null.
- "create_booking"     — action MUST be the booking params;       answer MUST be null.
- "cancel_booking"     — action MUST be the cancellation params;  answer MUST be null.
- "answer"             — action MUST be null; answer carries the structured response (conflict, price, etc.).
- "clarify"            — action MUST be null; answer carries { kind, payload } describing what the persona should ask.

ACTIONS:
  check_availability: { "type":"check_availability", "service_id":<n>, "date":"YYYY-MM-DD", "resource_id":<n|null>, "staff_id":<n|null> }
  create_booking:     { "type":"create_booking", "service_id":<n>, "start_time":"YYYY-MM-DDTHH:MM:00${tzOffsetStr}", "duration_minutes":<n>, "resource_id":<n|null>, "staff_id":<n|null>, "payment_method":"membership"|"package"|"cash"|"card"|"cliq", "membership_id":<n|null>, "prepaid_entitlement_id":<n|null>, "slots":<n> }
  cancel_booking:     { "type":"cancel_booking", "booking_id":<n> }

CRITICAL DECISION RULES — the parsing layer enforces these as structural belt-and-suspenders, but follow them yourself:

A. AVAILABILITY: never invent slot times from the business context. The business context tells you WHEN services operate (constraints); it does NOT tell you which slots are FREE. If the customer asks about availability, emit check_availability — never answer from the context.

B. CONFLICT CHECK: before proposing create_booking, scan the customer's UPCOMING BOOKINGS for any booking whose [start, start+duration] overlaps your proposed [start, start+duration]. If overlap exists, emit intent="answer" with kind="conflict" listing the conflicting booking — do NOT propose the booking.

C. PAYMENT ELIGIBILITY: each service lists allowsMembership=true|false. If false, NEVER set action.payment_method="membership" for that service. Use cash/cliq/card. The structural layer will reject and rewrite to clarify if you do.

D. PACKAGE ELIGIBILITY: each USABLE package lists eligibleServiceIds. If a list is given, the package may be applied ONLY to services in that list. NEVER set action.prepaid_entitlement_id for a package whose eligibleServiceIds excludes the chosen service.

E. CONFIRMATION FLOW: a "yes/ok/sure" reply triggers create_booking ONLY if the customer just received a concrete proposal (specific service, time, payment) in the prior assistant turn. If the reply is ambiguous, emit intent="clarify".

F. AMBIGUOUS RESOURCE: if the customer asks for a service that has multiple linked resources and (a) they did not name one, (b) they have no clear preference history, emit intent="clarify" with kind="resource_ambiguous" and payload { service_id, candidate_resource_ids: [...] }. Do NOT pick blindly.

═══════════════════════════════════════════════════
TENANT: ${tenantContext?.name || 'unknown'}
TIMEZONE: ${tenantTz} (offset ${tzOffsetStr})
TODAY: ${todayStr} (tomorrow: ${tomorrowStr})
═══════════════════════════════════════════════════

${businessBlock}

═══════════════════════════════════════════════════
${customerBlock}
═══════════════════════════════════════════════════

Return ONE JSON object only. No prose. No fences. No explanation.`;
}

// Lean business context: service IDs, resources, staff, payment eligibility.
// No working-hours speech, no rate-rule prose, no currency speech.
function buildBrainBusinessContext(ctx) {
  if (!ctx) return 'BUSINESS: (no context)';
  const services = Array.isArray(ctx.services) ? ctx.services : [];
  const resourceLinks = Array.isArray(ctx.resourceLinks) ? ctx.resourceLinks : [];
  const staffLinks = Array.isArray(ctx.staffLinks) ? ctx.staffLinks : [];

  const svcResources = {};
  for (const l of resourceLinks) {
    (svcResources[l.service_id] = svcResources[l.service_id] || [])
      .push({ id: l.resource_id, name: l.resource_name });
  }
  const svcStaff = {};
  for (const l of staffLinks) {
    (svcStaff[l.service_id] = svcStaff[l.service_id] || [])
      .push({ id: l.staff_id, name: l.staff_name });
  }

  const lines = ['SERVICES:'];
  if (services.length === 0) {
    lines.push('  (no services)');
  } else {
    for (const s of services) {
      const bits = [`service_id=${s.id}`, `"${s.name}"`];
      if (s.duration_minutes) bits.push(`duration=${s.duration_minutes}min`);
      if (s.slot_interval_minutes) bits.push(`slot=${s.slot_interval_minutes}min`);
      if (s.price != null) bits.push(`base=${Number(s.price).toFixed(2)} ${s.currency_code || 'JD'}`);
      bits.push(`allowsMembership=${s.allow_membership ? 'true' : 'false'}`);
      const rs = svcResources[s.id];
      if (rs && rs.length) bits.push(`resources=[${rs.map((r) => `${r.id}:${r.name}`).join(',')}]`);
      const st = svcStaff[s.id];
      if (st && st.length) bits.push(`staff=[${st.map((p) => `${p.id}:${p.name}`).join(',')}]`);
      lines.push(`  - ${bits.join(' | ')}`);
    }
  }
  return lines.join('\n');
}

// Lean customer context: UPCOMING (for conflict awareness) + USABLE NOW
// (for payment selection). No past-bookings prose; personalization signals
// are computed structurally and returned as a separate field on the brain
// output, not inlined into the prompt.
function buildBrainCustomerContext(customerData, tenantTz) {
  const profile = customerData?.profile || {};
  const bookings = Array.isArray(customerData?.bookings) ? customerData.bookings : [];
  const memberships = Array.isArray(customerData?.memberships) ? customerData.memberships : [];
  const packages = Array.isArray(customerData?.packages) ? customerData.packages : [];
  const now = Date.now();

  const upcoming = bookings
    .filter((b) => b && b.start_time && new Date(b.start_time).getTime() >= now)
    .filter((b) => b.status !== 'cancelled')
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .slice(0, 10);

  const usableMems = memberships.filter((m) => {
    if (m.status && m.status !== 'active') return false;
    if (m.end_at && new Date(m.end_at).getTime() <= now) return false;
    const minNum = m.minutes_remaining != null ? Number(m.minutes_remaining) : null;
    const useNum = m.uses_remaining != null ? Number(m.uses_remaining) : null;
    if (minNum === 0 && useNum === 0) return false;
    if (minNum != null && minNum <= 0 && useNum == null) return false;
    if (useNum != null && useNum <= 0 && minNum == null) return false;
    return true;
  });

  const usablePkgs = packages.filter((p) => {
    if (p.status && p.status !== 'active') return false;
    if (p.expires_at && new Date(p.expires_at).getTime() <= now) return false;
    if (p.remaining_quantity != null && Number(p.remaining_quantity) <= 0) return false;
    return true;
  });

  const lines = [`CUSTOMER: id=${profile.id ?? 'none'} | "${profile.name || ''}" | ${profile.email || ''}`];

  lines.push('UPCOMING BOOKINGS (use for CONFLICT CHECK):');
  if (upcoming.length === 0) {
    lines.push('  (none)');
  } else {
    for (const b of upcoming) {
      const dt = new Date(b.start_time).toLocaleString('en-GB', {
        timeZone: tenantTz, dateStyle: 'short', timeStyle: 'short',
      });
      lines.push(`  - booking_id=${b.id} | service_id=${b.service_id ?? '?'} "${b.service_name || ''}" | start=${b.start_time} (local ${dt}) | duration=${b.duration_minutes ?? '?'}min | resource=${b.resource_name || 'none'} | status=${b.status || '?'}`);
    }
  }

  lines.push('USABLE NOW (proactively offer when eligible):');
  if (usableMems.length === 0 && usablePkgs.length === 0) {
    lines.push('  (none — cash/cliq/card only)');
  } else {
    for (const m of usableMems) {
      const bal = m.minutes_remaining != null ? `${m.minutes_remaining}min`
                : m.uses_remaining != null ? `${m.uses_remaining} uses`
                : 'unlimited';
      lines.push(`  - MEMBERSHIP membership_id=${m.id} "${m.plan_name || ''}" — ${bal} | appliesWhenServiceAllowsMembership=true`);
    }
    for (const p of usablePkgs) {
      const eligible = Array.isArray(p.eligible_service_ids) && p.eligible_service_ids.length > 0
        ? `eligibleServiceIds=[${p.eligible_service_ids.join(',')}]`
        : 'eligibleServiceIds=ALL';
      const rem = p.remaining_quantity != null ? `${p.remaining_quantity} remaining` : '';
      lines.push(`  - PACKAGE prepaid_entitlement_id=${p.id} "${p.product_name || ''}" — ${rem} | ${eligible}`);
    }
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: runBookingBrain — single entry point.
// Always returns an object of the documented shape; never throws upstream.
// ─────────────────────────────────────────────────────────────────────────────
async function runBookingBrain({
  tenantContext,
  customerData = null,
  isSignedIn = false,
  history = [],
  message,
  confirmationMode = false,
}) {
  const personalization = computePersonalization(customerData);
  const systemPrompt = buildBrainPrompt({ tenantContext, customerData, isSignedIn });

  // confirmationMode hint via the user turn — keeps the system prompt
  // stable across turns (same cache key, high cache-hit rate).
  const confirmNote = confirmationMode
    ? '\n\n[SYSTEM_NOTE: confirmationMode=true — the customer just confirmed a previously proposed booking. Emit intent="create_booking" with the params from that proposal, picking the exact IDs / times / payment_method already discussed.]'
    : '';

  let rawText = '';
  try {
    const response = await claude.messages.create({
      model: BRAIN_MODEL,
      max_tokens: BRAIN_MAX_TOKENS,
      temperature: BRAIN_TEMPERATURE,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        ...(Array.isArray(history) ? history : []),
        { role: 'user', content: (message || '') + confirmNote },
      ],
    });
    rawText = response?.content?.[0]?.text || '';
  } catch (err) {
    // Surface as a structured clarify so the orchestrator can recover.
    return {
      intent: 'clarify',
      action: null,
      answer: { kind: 'brain_error', payload: { message: err?.message || String(err) } },
      personalization,
      raw: '',
    };
  }

  const parsed = parseBrainOutput(rawText);
  if (!parsed) {
    return {
      intent: 'clarify',
      action: null,
      answer: { kind: 'parse_failure', payload: { rawHead: rawText.slice(0, 200) } },
      personalization,
      raw: rawText,
    };
  }

  const rewritten = applyStructuralFallbacks({ parsed, tenantContext, customerData });

  // Normalize shape — missing fields become null so consumers do not null-check.
  return {
    intent: rewritten.intent || 'clarify',
    action: rewritten.action ?? null,
    answer: rewritten.answer ?? null,
    personalization,
    raw: rawText,
  };
}

module.exports = {
  runBookingBrain,
  // Test exports (underscored — not for production consumers)
  _computePersonalization: computePersonalization,
  _parseBrainOutput: parseBrainOutput,
  _applyStructuralFallbacks: applyStructuralFallbacks,
  _detectUpcomingConflict: detectUpcomingConflict,
  _buildBrainPrompt: buildBrainPrompt,
  _constants: { BRAIN_MODEL, BRAIN_MAX_TOKENS, BRAIN_TEMPERATURE },
};
