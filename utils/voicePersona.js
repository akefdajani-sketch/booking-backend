'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// utils/voicePersona.js — Phase 2.2
//
// Persona layer for the booking voice/chat agent. Takes the BRAIN's structured
// decision (utils/bookingBrain.js) plus the ORCHESTRATOR's action result and
// renders prose for the customer. Returns { reply, pendingBooking } as
// structured outputs; pendingBooking is NEVER emitted by Claude — it is
// computed deterministically from brainOutput.answer.payload.
//
// The persona is UNWIRED in 2.2 — nothing in production calls it. Orchestrator
// wire-up is Phase 2.3.
//
// ARCHITECTURAL PRINCIPLE — STRUCTURAL SEPARATION:
//   The persona has NO path to fire actions, mutate decisions, fabricate
//   slots, or override the brain. Together with 2.1's structural fallbacks,
//   this makes Bugs B (concurrent conflict) and C (fabricated slots)
//   structurally impossible in the persona layer — not just covered by tests.
//
//     • NO db import       — cannot read/write bookings.
//     • NO handleAction    — cannot fire actions.
//     • brainOutput / actionResult immutable inputs (never mutated in JS).
//     • pendingBooking computed by code, not by Claude.
//     • Prompt outputs prose only; no JSON, no wire-format lines.
//     • Currency strings PRE-RENDERED via _renderCurrency (no LLM hallucination
//       of "J-O-D eleven point five zero").
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');

const PERSONA_MODEL = 'claude-sonnet-4-6';
const PERSONA_MAX_TOKENS = 200;
const PERSONA_TEMPERATURE = 0.3;

const claude = new Anthropic();

// ─────────────────────────────────────────────────────────────────────────────
// Number-to-words (pure JS, 0-99) — used by _renderCurrency.
// ─────────────────────────────────────────────────────────────────────────────
const EN_ONES  = ['zero','one','two','three','four','five','six','seven','eight','nine'];
const EN_TEENS = ['ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const EN_TENS  = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

function englishNumberWord(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 10) return EN_ONES[n];
  if (n < 20) return EN_TEENS[n - 10];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? EN_TENS[tens] : `${EN_TENS[tens]}-${EN_ONES[ones]}`;
  }
  return String(n);
}

// Arabic cardinal masculine 0-99; teens use 11-19 forms with عشر,
// compounds (X1-X9) use "<ones> و<tens>" pattern (e.g. خمسة وعشرون = 25).
const AR_ONES  = ['صفر','واحد','اثنان','ثلاثة','أربعة','خمسة','ستة','سبعة','ثمانية','تسعة'];
const AR_TEENS = ['عشرة','أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر','ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
const AR_TENS  = ['','','عشرون','ثلاثون','أربعون','خمسون','ستون','سبعون','ثمانون','تسعون'];

function arabicNumberWord(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 10) return AR_ONES[n];
  if (n < 20) return AR_TEENS[n - 10];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? AR_TENS[tens] : `${AR_ONES[ones]} و${AR_TENS[tens]}`;
  }
  return String(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// _renderCurrency — pure JS, source rules from claudeService.js L548-577.
// Approved JD mapping table (ak, 2026-05-17). For 0 ≤ amount < 100,
// full implementation; for ≥ 100, simple integer-then-piasters fallback.
// TODO: extend ≥ 100 fraction rules if a tenant needs it. Birdie's prices
// are all < 100 JOD so the fallback is invisible today.
// ─────────────────────────────────────────────────────────────────────────────
function renderCurrency(amount, currency, language) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return '';

  const cur = String(currency || 'JD').toUpperCase();
  const lang = language === 'ar' ? 'ar' : 'en';

  // Non-JD fallback (decision 3 — vague fallback).
  // TODO: implement natural-speech rules per currency when a non-JD tenant
  // enables voice. For now, simple digit + code.
  if (cur !== 'JD') {
    return `${n} ${cur}`;
  }

  // amount === 0
  if (n === 0) return lang === 'ar' ? 'مجاناً' : 'no charge';

  // Round to 2 decimals to avoid floating-point artifacts (e.g. 11.4 → 11.40)
  const cents = Math.round(n * 100);
  const dinars = Math.floor(cents / 100);
  const piasters = cents % 100;

  // Sub-dinar: piasters alone
  if (dinars === 0) {
    if (piasters === 0) return lang === 'ar' ? 'مجاناً' : 'no charge';
    return lang === 'ar'
      ? `${arabicNumberWord(piasters)} قرشاً`
      : `${englishNumberWord(piasters)} piasters`;
  }

  // Pure whole dinars
  if (piasters === 0) {
    return wholeDinars(dinars, lang);
  }

  // Common fractions .25 / .50 / .75
  if (piasters === 25 || piasters === 50 || piasters === 75) {
    return commonFractionDinars(dinars, piasters, lang);
  }

  // Other piaster amounts
  return piasterFractionDinars(dinars, piasters, lang);
}

function wholeDinars(dinars, lang) {
  if (lang === 'ar') {
    if (dinars === 1) return 'دينار واحد';
    if (dinars === 2) return 'دیناران';
    if (dinars >= 3 && dinars <= 10) return `${arabicNumberWord(dinars)} دنانير`;
    if (dinars >= 11 && dinars <= 99) return `${arabicNumberWord(dinars)} ديناراً`;
    if (dinars === 100) return 'مئة دينار';
    return `${dinars} دينار`; // ≥ 101 fallback
  }
  if (dinars === 1) return 'one dinar';
  if (dinars === 100) return 'a hundred dinars';
  if (dinars >= 2 && dinars <= 99) return `${englishNumberWord(dinars)} dinars`;
  return `${dinars} dinars`; // ≥ 101 fallback
}

function commonFractionDinars(dinars, piasters, lang) {
  const fracEn = { 25: 'a quarter', 50: 'a half', 75: 'three quarters' };
  const fracAr = { 25: 'وربع', 50: 'ونصف', 75: 'وثلاثة أرباع' };

  if (lang === 'ar') {
    if (dinars === 1) return `دينار ${fracAr[piasters]}`;
    if (dinars === 2) return `دیناران ${fracAr[piasters]}`;
    if (dinars >= 3 && dinars <= 10) return `${arabicNumberWord(dinars)} دنانير ${fracAr[piasters]}`;
    if (dinars >= 11 && dinars <= 99) return `${arabicNumberWord(dinars)} ديناراً ${fracAr[piasters]}`;
    return `${dinars} دينار ${fracAr[piasters]}`; // ≥ 100 fallback
  }
  if (dinars === 1) return `one and ${fracEn[piasters]} dinars`;
  if (dinars >= 2 && dinars <= 99) return `${englishNumberWord(dinars)} and ${fracEn[piasters]} dinars`;
  return `${dinars} dinars and ${piasters} piasters`; // ≥ 100 fallback (simple)
}

function piasterFractionDinars(dinars, piasters, lang) {
  if (lang === 'ar') {
    if (dinars === 1) return `دينار و${arabicNumberWord(piasters)} قرشاً`;
    if (dinars === 2) return `دیناران و${arabicNumberWord(piasters)} قرشاً`;
    if (dinars >= 3 && dinars <= 10) return `${arabicNumberWord(dinars)} دنانير و${arabicNumberWord(piasters)} قرشاً`;
    if (dinars >= 11 && dinars <= 99) return `${arabicNumberWord(dinars)} ديناراً و${arabicNumberWord(piasters)} قرشاً`;
    return `${dinars} دينار و${piasters} قرشاً`; // ≥ 100 fallback
  }
  if (dinars === 1) return `one dinar and ${englishNumberWord(piasters)} piasters`;
  if (dinars >= 2 && dinars <= 99) return `${englishNumberWord(dinars)} dinars and ${englishNumberWord(piasters)} piasters`;
  return `${dinars} dinars and ${piasters} piasters`; // ≥ 100 fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// _renderPendingBooking — pure JS, computes the structured pendingBooking
// field directly from the brain output. NEVER emitted by Claude.
//
// Per decision 1 (ak, 2026-05-17): the brain signals proposal turns via
//   intent='clarify', answer.kind='confirm_proposal',
//   answer.payload={ service_id, start_time, duration_minutes, resource_id,
//                    staff_id, payment_method, membership_id,
//                    prepaid_entitlement_id, slots }
// Everything else returns null.
// ─────────────────────────────────────────────────────────────────────────────
function renderPendingBooking(brainOutput) {
  if (!brainOutput || typeof brainOutput !== 'object') return null;
  if (brainOutput.intent !== 'clarify') return null;
  if (brainOutput.answer?.kind !== 'confirm_proposal') return null;
  const p = brainOutput.answer.payload;
  if (!p || typeof p !== 'object') return null;
  return {
    service_id: p.service_id ?? null,
    start_time: p.start_time ?? null,
    duration_minutes: p.duration_minutes ?? null,
    resource_id: p.resource_id ?? null,
    staff_id: p.staff_id ?? null,
    payment_method: p.payment_method ?? null,
    membership_id: p.membership_id ?? null,
    prepaid_entitlement_id: p.prepaid_entitlement_id ?? null,
    slots: p.slots ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persona prompt builders
// ─────────────────────────────────────────────────────────────────────────────
function buildPersonaSystemPrompt({ tenantContext, language, consumerType }) {
  const lang = language === 'ar' ? 'ar' : 'en';
  const tenantName = tenantContext?.name || 'this business';
  return `You are the PERSONA layer of a booking agent for ${tenantName}. The brain has already decided what to do; your job is to phrase that decision naturally for the customer.

CRITICAL CONSTRAINTS:
- You have NO booking authority. The brain decided. You speak.
- NEVER invent slot times, prices, booking IDs, or service names. If a value is not in the structured input, do NOT mention it.
- NEVER read currency codes (JOD, USD) or decimal numbers ("eleven point five zero") aloud. Use the PRE-RENDERED currency strings as-is.
- NEVER mention payment options not listed in the structured input.
- NEVER output JSON, markdown code fences, ACTION lines, or PENDING_BOOKING wire lines. Plain prose only.

LANGUAGE: ${lang === 'ar' ? 'Arabic only' : 'English only'}. Never mix languages within a response.

TONE:
- Concise, warm, professional.
- ${consumerType === 'voice' ? 'Phone-style: short sentences, no bullet points.' : 'Chat-style: short and clear; brief bullets OK for option lists.'}
- End with a clear next step or question.
- If something is not in the structured input below, say so honestly — do not invent.

OUTPUT: One short reply in plain prose. Nothing else.`;
}

function buildPersonaUserTurn({ tenantContext, brainOutput, actionResult, language }) {
  const lang = language === 'ar' ? 'ar' : 'en';
  const lines = [];

  // ── Brain decision summary ───────────────────────────────────────
  lines.push('BRAIN DECISION:');
  lines.push(`  intent: ${brainOutput?.intent || 'unknown'}`);
  if (brainOutput?.action) {
    lines.push(`  action: ${JSON.stringify(brainOutput.action)}`);
  }
  if (brainOutput?.answer) {
    lines.push(`  answer.kind: ${brainOutput.answer.kind || 'unspecified'}`);
    if (brainOutput.answer.payload != null) {
      lines.push(`  answer.payload: ${JSON.stringify(brainOutput.answer.payload)}`);
    }
  }
  if (brainOutput?.personalization) {
    const p = brainOutput.personalization;
    if (p.usualResourceId != null && p.usualResourceName) {
      lines.push(`  personalization: customer usually books ${p.usualResourceName} (id ${p.usualResourceId}); ${p.bookingsCountLast90Days || 0} bookings in last 90 days. Surface as a soft suggestion only when relevant — never override an explicit request.`);
    }
  }

  // ── Action result summary ───────────────────────────────────────
  lines.push('');
  if (!actionResult) {
    lines.push('ACTION RESULT: (no action executed for this turn)');
  } else {
    lines.push('ACTION RESULT:');
    lines.push(`  success: ${actionResult.success === true}`);
    if (actionResult.message) lines.push(`  message: ${actionResult.message}`);
    if (actionResult.bookingId) lines.push(`  bookingId: ${actionResult.bookingId}`);
    if (Array.isArray(actionResult.slots) && actionResult.slots.length > 0) {
      lines.push('  available slots:');
      for (const s of actionResult.slots.slice(0, 12)) {
        const resBits = Array.isArray(s.resources)
          ? s.resources.map((r) => {
              if (r.free) return `${r.name} FREE`;
              if (r.ownership === 'YOUR') return `${r.name} BOOKED (your existing)`;
              if (r.ownership === 'OTHER') return `${r.name} BOOKED (other customer)`;
              return `${r.name} BUSY`;
            }).join(', ')
          : '';
        lines.push(`    - ${s.time}: ${resBits}`);
      }
    }
    if (actionResult.capHit) {
      lines.push('  note: result capped — encourage customer to narrow resource/staff if they want full coverage.');
    }
  }

  // ── Pre-rendered currency hints (if action has a price-relevant context) ──
  const services = Array.isArray(tenantContext?.services) ? tenantContext.services : [];
  let priceHint = null;
  const svcId = brainOutput?.action?.service_id
    ?? brainOutput?.answer?.payload?.service_id
    ?? null;
  if (svcId != null) {
    const svc = services.find((s) => Number(s.id) === Number(svcId));
    if (svc && svc.price != null) {
      priceHint = renderCurrency(Number(svc.price), svc.currency_code || 'JD', lang);
    }
  }
  if (priceHint) {
    lines.push('');
    lines.push(`PRE-RENDERED PRICE for service_id=${svcId}: "${priceHint}" (use this string verbatim when quoting price; do NOT re-derive)`);
  }

  // ── Per-kind composition guidance ───────────────────────────────
  lines.push('');
  lines.push(`LANGUAGE: ${lang}`);
  lines.push('');
  lines.push('COMPOSE THE REPLY:');
  lines.push(perKindGuidance(brainOutput, actionResult));

  return lines.join('\n');
}

function perKindGuidance(brainOutput, actionResult) {
  const intent = brainOutput?.intent;
  const kind = brainOutput?.answer?.kind;

  if (intent === 'check_availability') {
    if (actionResult?.success && Array.isArray(actionResult.slots) && actionResult.slots.length > 0) {
      return 'Tell the customer which times are open from the structured slots above. Name specific resources when relevant. End with "which time works?" or equivalent.';
    }
    if (actionResult && !actionResult.success) {
      return `Tell the customer the check failed. Use the message above verbatim if it explains the situation; otherwise apologize briefly and offer to try a different date.`;
    }
    return 'Tell the customer you are looking that up. Do NOT invent specific times.';
  }
  if (intent === 'create_booking') {
    if (actionResult?.success) {
      return 'Confirm the booking. Reference the booking id and the service. Keep it short.';
    }
    return 'Tell the customer the booking did not go through. Use the failure message verbatim if it is customer-appropriate; offer an alternative.';
  }
  if (intent === 'cancel_booking') {
    if (actionResult?.success) {
      return 'Confirm the cancellation succinctly.';
    }
    return 'Tell the customer the cancellation could not be done; use the failure message verbatim if customer-appropriate.';
  }
  if (intent === 'answer') {
    if (kind === 'conflict') {
      return 'Explain the conflict: the customer already has a booking at the conflicting time. Name the conflicting service and time. Ask if they want a different time or to cancel the existing booking.';
    }
    return 'Phrase the structured answer naturally for the customer.';
  }
  if (intent === 'clarify') {
    if (kind === 'confirm_proposal') {
      return 'Read back the proposed booking details (service, time, duration, price if available, payment method). End with "shall I confirm?" or equivalent. Do NOT execute anything — the customer must confirm next.';
    }
    if (kind === 'resource_ambiguous') {
      return 'List the candidate resources by name. Ask the customer to pick one. Use plain prose; voice consumer = no bullet points.';
    }
    if (kind === 'payment_method_invalid') {
      return 'Explain that the chosen service does NOT accept the requested payment method (membership). Offer the alternatives (cash, CliQ, card). Do NOT list membership as an option for this booking.';
    }
    if (kind === 'package_ineligible') {
      return 'Explain that the customer\'s package does not apply to this service. Suggest cash, CliQ, or card.';
    }
    if (kind === 'parse_failure' || kind === 'brain_error') {
      return 'Apologize briefly and ask the customer to rephrase or repeat. Do NOT mention internal errors.';
    }
    if (kind === 'need_proposal') {
      return 'Ask the customer what they would like to book — service, date, time. Keep it short.';
    }
    return 'Ask the customer for the missing information based on the answer payload.';
  }
  return 'Reply naturally based on the structured input above.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: speakReply — single entry point.
// Always returns { reply, pendingBooking }. Never throws upstream.
// ─────────────────────────────────────────────────────────────────────────────
async function speakReply({
  tenantContext,
  brainOutput,
  actionResult = null,
  language = 'en',
  consumerType = 'chat',
}) {
  // pendingBooking is computed up front — deterministic, never from Claude.
  const pendingBooking = renderPendingBooking(brainOutput);

  // Drop-recovery short-circuit (voice-booking-approval-gate, 2026-05-26):
  // when the gate dropped a create_booking on this turn, the orchestrator
  // transformed the would-be action into a confirm_proposal-shaped brainOutput.
  // Skip Claude and emit the deterministic re-propose prose — its output
  // satisfies Threshold G by construction (see utils/voiceBookingApprovalGate.js
  // and the recovery-template pin in __tests__/voiceBookingApprovalGate.test.js).
  if (
    actionResult?.dropped === true
    && brainOutput?.intent === 'clarify'
    && brainOutput?.answer?.kind === 'confirm_proposal'
  ) {
    const { formatDeterministicReProposeReply } = require('./voiceBookingApprovalGate');
    const reply = formatDeterministicReProposeReply({
      payload: brainOutput.answer.payload,
      tenantContext,
      language,
    });
    return { reply, pendingBooking };
  }

  const systemPrompt = buildPersonaSystemPrompt({ tenantContext, language, consumerType });
  const userTurn = buildPersonaUserTurn({ tenantContext, brainOutput, actionResult, language });

  let rawText = '';
  try {
    const response = await claude.messages.create({
      model: PERSONA_MODEL,
      max_tokens: PERSONA_MAX_TOKENS,
      temperature: PERSONA_TEMPERATURE,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userTurn }],
    });
    rawText = response?.content?.[0]?.text || '';
  } catch (err) {
    // Generic fallback — never throw upstream. Language-aware.
    const fallback = language === 'ar'
      ? 'عذراً، صار خطأ بسيط. ممكن تعيد طلبك؟'
      : 'Sorry, something went wrong. Could you say that again?';
    return { reply: fallback, pendingBooking };
  }

  return { reply: (rawText || '').trim(), pendingBooking };
}

module.exports = {
  speakReply,
  // Test exports (underscored — not for production consumers)
  _renderCurrency: renderCurrency,
  _renderPendingBooking: renderPendingBooking,
  _buildPersonaSystemPrompt: buildPersonaSystemPrompt,
  _buildPersonaUserTurn: buildPersonaUserTurn,
  _englishNumberWord: englishNumberWord,
  _arabicNumberWord: arabicNumberWord,
  _constants: { PERSONA_MODEL, PERSONA_MAX_TOKENS, PERSONA_TEMPERATURE },
};
