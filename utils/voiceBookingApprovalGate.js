'use strict';

// utils/voiceBookingApprovalGate.js
//
// Route-level approval gate for create_booking. Closes the phantom-booking
// class (May 4 BOOKING-DROP-FIX-1.1 / VOICE-FIX-5): the voice/chat agent
// could write a booking to the DB before the customer approved a summary.
// The 7-step contract was prompt-only; nothing structural enforced it.
//
// Three callsites delegate to executeActionWithGate(): routes/ai.js,
// routes/voice.js, utils/claudeService.js (two-query orchestrator). Plus
// the pre-runSupportAgent direct-execute branch on each route also requires
// the second factor (confirmationMode === true), not just pendingAction.
//
// TWO-FACTOR APPROVAL:
//   (pendingAction.type === 'create_booking' AND confirmationMode === true)
//   OR
//   (confirmationMode === true AND priorAssistantTurnHasConcreteProposal(history))
//
// Both clauses require confirmationMode. The sidecar is the recovery
// authorisation channel (clean round-trip, immune to EL TTS+STT mutation).
// Prose-G is the legacy fallback for Claude-generated proposals that lack
// a parseable PENDING_BOOKING sidecar line.
//
// Threshold P (lenient) drives confirmationMode only — no DB consequence.
// Threshold G (strict) adds clock-time on top of P and authorises the write.
//
// 1-ENTRY history scan: scans the LAST assistant turn only. A 2-entry scan
// would over-permit on text where stale -2 + filler -1 + customer "yes"
// falsely satisfies G against the stale proposal.
//
// ARABIC LITERALS: stored as raw UTF-8 chars in source. Encoding safety is
// enforced by the codepoint-assertion test cases in
// __tests__/voiceBookingApprovalGate.test.js (every literal locked to its
// expected codepoint sequence). If a stray editor normalisation or copy-paste
// swap mutates the bytes, CI fails immediately.
//
// LIMITATIONS:
//   - prose-G's Arabic whitelist is verified against the deterministic
//     recovery template (uses أؤكد only). Coverage against live
//     Claude-generated Arabic on legacy single-query tenants is UNVERIFIED.
//     TODO(arabic-legacy-tenant): verify against real Claude Arabic
//     transcripts before shipping voice in AR to a non-Birdie tenant.
//   - The voice frontend (useElevenLabsAgent.ts) does NOT clear pendingRef
//     when the server returns no pendingBooking. A turn that doesn't
//     re-emit a proposal leaves the prior sidecar in place. Mitigation:
//     every drop transforms to confirm_proposal so the sidecar is refreshed
//     each turn (handled by transformDroppedToProposal). Cleaner fix is in
//     the frontend; deferred.
//   - The text frontend (TextModeBody.tsx) overwrites pendingRef to null
//     when the server returns no pendingBooking. An intervening unrelated
//     turn drops the sidecar; later "yes" falls to prose-G. UX limitation,
//     not a safety issue.

// ── Thresholds ───────────────────────────────────────────────────────────────

// EN confirm-keywords — same vocab as the prior routes/ai.js hasRecentPendingBooking.
const EN_CONFIRM_KEYWORDS = /\b(confirm|shall i|book it|proceed|go ahead)\b/i;

// AR confirm-keywords. Codepoint table (verify at runtime via tests):
//   أؤكد       (I confirm)    : U+0623, U+0624, U+0643, U+062F
//   أحجز       (I book)       : U+0623, U+062D, U+062C, U+0632
//   نؤكد       (we confirm)   : U+0646, U+0624, U+0643, U+062F  ← hamza-on-WĀW
//   تأكيد      (confirmation) : U+062A, U+0623, U+0643, U+064A, U+062F
const AR_CONFIRM_KEYWORDS = new RegExp(
  'أؤكد|أحجز|نؤكد|تأكيد'
);

// Ends with `?` (U+003F) or Arabic question mark `؟` (U+061F).
const ENDS_WITH_Q = /[?؟]\s*$/;

// Clock-time pattern. Matches HH:MM (Latin 0-9 OR Arabic-Indic ٠-٩
// U+0660..U+0669) optionally followed by am/pm; OR bare "H am/pm" /
// "HH AM/PM" (Latin).
const CLOCK_TIME = /(?:\d{1,2}|[٠-٩]{1,2}):(?:\d{2}|[٠-٩]{2})|\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)\b/i;

// Arabic AM/PM-style time markers — root stems (no diacritics, no case endings).
//   صباح (morning) : U+0635, U+0628, U+0627, U+062D
//   مساء (evening) : U+0645, U+0633, U+0627, U+0621
//   ليل  (night)   : U+0644, U+064A, U+0644
//   ظهر  (noon)    : U+0638, U+0647, U+0631
const AR_TIME_MARKER = new RegExp(
  'صباح|مساء|ليل|ظهر'
);

// ── Threshold P (lenient) — drives confirmationMode only ─────────────────────
function hasRecentPendingBooking(history) {
  if (!Array.isArray(history) || history.length === 0) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const t = m.content;
    const ends = ENDS_WITH_Q.test(t.trim());
    const kw   = EN_CONFIRM_KEYWORDS.test(t) || AR_CONFIRM_KEYWORDS.test(t);
    return ends && kw;
  }
  return false;
}

// ── Threshold G (strict) — authorises the DB write ───────────────────────────
function priorAssistantTurnHasConcreteProposal(history) {
  if (!Array.isArray(history) || history.length === 0) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const t = m.content;
    const ends = ENDS_WITH_Q.test(t.trim());
    const kw   = EN_CONFIRM_KEYWORDS.test(t) || AR_CONFIRM_KEYWORDS.test(t);
    const time = CLOCK_TIME.test(t) || AR_TIME_MARKER.test(t);
    return ends && kw && time;
  }
  return false;
}

// ── Composite — two-factor authorisation ─────────────────────────────────────
// BOTH clauses require confirmationMode === true.
function hasCreateBookingApproval({ pendingAction, confirmationMode, history }) {
  if (confirmationMode !== true) return false;
  if (pendingAction?.type === 'create_booking') return true;
  if (priorAssistantTurnHasConcreteProposal(history)) return true;
  return false;
}

// ── Drop → re-propose transform ──────────────────────────────────────────────
// Builds the next-turn sidecar from the CURRENT turn's would-be action.
// The persona's renderPendingBooking (utils/voicePersona.js L181-198) emits
// the structured pendingBooking field from this shape, so the client mirrors
// the refreshed proposal — never a stale carry-over.
function transformDroppedToProposal(action) {
  if (!action || action.type !== 'create_booking') return null;
  return {
    intent: 'clarify',
    action: null,
    answer: {
      kind: 'confirm_proposal',
      payload: {
        service_id: action.service_id ?? null,
        start_time: action.start_time ?? null,
        duration_minutes: action.duration_minutes ?? null,
        resource_id: action.resource_id ?? null,
        staff_id: action.staff_id ?? null,
        payment_method: action.payment_method ?? null,
        membership_id: action.membership_id ?? null,
        prepaid_entitlement_id: action.prepaid_entitlement_id ?? null,
        slots: action.slots ?? null,
      },
    },
  };
}

// ── Execute-or-drop primitive ────────────────────────────────────────────────
// Non-create_booking actions (check_availability, cancel_booking) bypass the
// gate — they don't write to the bookings table.
async function executeActionWithGate({
  action,
  isApprovedForCreateBooking,
  handleAction,
  context,
  logger,
}) {
  if (!action) return null;
  if (action.type === 'create_booking' && isApprovedForCreateBooking !== true) {
    const log = logger || console;
    (log.warn || log.log).call(log,
      '[voiceBookingApprovalGate] create_booking DROPPED — no approval signal',
      {
        service_id: action.service_id,
        start_time: action.start_time,
        payment_method: action.payment_method,
      });
    return {
      success: false,
      dropped: true,
      reason: 'no_approval_signal',
      message: 'Booking not yet confirmed — re-proposed for explicit approval.',
    };
  }
  const c = context || {};
  return handleAction(action, c.tenantId, c.tenantSlug, c.customerId, c.email, c.authToken);
}

// ── Deterministic re-propose prose (option α) ────────────────────────────────
// Output satisfies Threshold G BY CONSTRUCTION:
//   - contains a confirm-keyword (أؤكد / "Shall I confirm")
//   - contains a clock-time pattern (HH:MM AM/PM)
//   - ends with `?` / `؟`
// The recovery-template pin in the test file asserts every
// (language × time-format × payment-method) combo of the actual builder
// output passes the gate. CI fails if a future edit drifts outside the
// whitelist.

// AR AM/PM suffix words used in the EN→AR time substitution:
//   صباحاً (morning + tanwīn fatḥa) : U+0635, U+0628, U+0627, U+062D, U+0627, U+064B
//   مساءً  (evening + tanwīn fatḥa) : U+0645, U+0633, U+0627, U+0621, U+064B
const AR_AM_SUFFIX = 'صباحاً';
const AR_PM_SUFFIX = 'مساءً';

function formatClockTime(startTimeIso, tz, lang) {
  // Returns "8:00 PM" (EN) or "8:00 <AR_PM_SUFFIX>" (AR).
  // Invalid/missing input → fallback that still satisfies G's CLOCK_TIME regex.
  const fallback = lang === 'ar' ? '12:00 ' + AR_AM_SUFFIX : '12:00 AM';
  if (!startTimeIso) return fallback;
  let date;
  try {
    date = new Date(startTimeIso);
    if (!Number.isFinite(date.getTime())) return fallback;
  } catch (_) { return fallback; }
  let enStr;
  try {
    enStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch (_) { return fallback; }
  if (lang !== 'ar') return enStr;
  // AR: keep Latin digits (so CLOCK_TIME regex matches), swap AM/PM token
  // for the Arabic time-marker so AR_TIME_MARKER also matches (defence in depth).
  return enStr
    .replace(/\bAM\b/, AR_AM_SUFFIX)
    .replace(/\bPM\b/, AR_PM_SUFFIX);
}

function formatPaymentMethod(method, lang) {
  // Codepoint table (each entry verified by codepoint, NOT glyph rendering):
  //   cash       نقداً : U+0646, U+0642, U+062F, U+0627, U+064B
  //   card       بطاقة : U+0628, U+0637, U+0627, U+0642, U+0629
  //   membership اشتراك: U+0627, U+0634, U+062A, U+0631, U+0627, U+0643
  //   package    باقة  : U+0628, U+0627, U+0642, U+0629
  //   cliq       keeps Latin "CliQ" — proper noun
  const ar = {
    cash:       'نقداً',
    cliq:       'CliQ',
    card:       'بطاقة',
    membership: 'اشتراك',
    package:    'باقة',
  };
  const en = {
    cash:       'cash',
    cliq:       'CliQ',
    card:       'card',
    membership: 'membership',
    package:    'package',
  };
  const map = lang === 'ar' ? ar : en;
  const m = String(method || '').toLowerCase();
  return map[m] || (lang === 'ar' ? 'نقداً' : 'cash');
}

function formatDeterministicReProposeReply({ payload, tenantContext, language }) {
  const lang = language === 'ar' ? 'ar' : 'en';
  const services = Array.isArray(tenantContext?.services) ? tenantContext.services : [];
  const svc = services.find((s) => Number(s.id) === Number(payload?.service_id));
  // Fallback service name: الخدمة (the service) : U+0627, U+0644, U+062E, U+062F, U+0645, U+0629
  const serviceName = svc?.name || (lang === 'ar' ? 'الخدمة' : 'the service');
  const tz = tenantContext?.timezone || 'Asia/Amman';
  const dur = Number(payload?.duration_minutes) || Number(svc?.duration_minutes) || 60;
  const timeStr = formatClockTime(payload?.start_time, tz, lang);
  const paymentStr = formatPaymentMethod(payload?.payment_method, lang);

  if (lang === 'ar') {
    // Template tokens (RTL — codepoints listed in logical order; glyphs render right-to-left):
    //   عند                : U+0639, U+0646, U+062F                              (at)
    //   الساعة             : U+0627, U+0644, U+0633, U+0627, U+0639, U+0629     (the hour)
    //   ،                  : U+060C                                              (Arabic comma)
    //   لمدة               : U+0644, U+0645, U+062F, U+0629                      (for)
    //   دقيقة              : U+062F, U+0642, U+064A, U+0642, U+0629              (minute)
    //   هل                 : U+0647, U+0644                                      (do/does)
    //   أؤكد               : confirm-keyword from whitelist above
    //   الحجز              : U+0627, U+0644, U+062D, U+062C, U+0632              (the booking)
    //   ؟                  : U+061F                                              (Arabic ?)
    return serviceName
      + ' عند الساعة '
      + timeStr
      + '، '
      + paymentStr
      + '، لمدة '
      + dur
      + ' دقيقة. هل أؤكد الحجز؟';
  }
  // EN: "Service at TIME, PAYMENT, DUR minutes. Shall I confirm?"
  return `${serviceName} at ${timeStr}, ${paymentStr}, ${dur} minutes. Shall I confirm?`;
}

module.exports = {
  hasRecentPendingBooking,
  priorAssistantTurnHasConcreteProposal,
  hasCreateBookingApproval,
  transformDroppedToProposal,
  executeActionWithGate,
  formatDeterministicReProposeReply,
  // Test exports (underscored — internal helpers; not for production consumers)
  _formatClockTime: formatClockTime,
  _formatPaymentMethod: formatPaymentMethod,
  _patterns: {
    EN_CONFIRM_KEYWORDS, AR_CONFIRM_KEYWORDS,
    ENDS_WITH_Q, CLOCK_TIME, AR_TIME_MARKER,
  },
};
