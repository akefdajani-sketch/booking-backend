'use strict';

// Voice-booking-approval-gate (2026-05-26) — unit tests.
//
// Coverage:
//   - Threshold P (lenient, drives confirmationMode only)
//   - Threshold G (strict, authorises DB write) — 1-entry scan strictness
//   - Composite hasCreateBookingApproval — TWO-FACTOR truth table
//   - transformDroppedToProposal — shape
//   - executeActionWithGate — handleAction spy (call-count + args)
//   - formatDeterministicReProposeReply — content shape (EN/AR)
//   - RECOVERY TEMPLATE PIN — REAL builder output × lang × time × payment;
//     load-bearing CI invariant. A template edit that drifts outside the
//     Threshold G whitelist fails this group.
//   - No-infinite-loop integration: drop → deterministic prose → next turn
//     passes the gate → handleAction called exactly once across the pair.
//   - Codepoint-assertion: every Arabic literal in voiceBookingApprovalGate.js
//     is locked to its expected codepoint sequence. Catches editor or
//     copy-paste byte mutation.
//
// All pure JS. No SDK mocking. Sub-second runtime.

const {
  hasRecentPendingBooking,
  priorAssistantTurnHasConcreteProposal,
  hasCreateBookingApproval,
  transformDroppedToProposal,
  executeActionWithGate,
  formatDeterministicReProposeReply,
  _formatClockTime,
  _formatPaymentMethod,
  _patterns,
} = require('../utils/voiceBookingApprovalGate');

// Tiny helpers
const asst = (content) => ({ role: 'assistant', content });
const user = (content) => ({ role: 'user', content });
function codepoints(s) {
  const out = [];
  for (const ch of s) out.push('U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
  return out.join(' ');
}

// Realistic Birdie tenantContext shape used across the pin tests.
const BIRDIE_CTX = {
  id: 3,
  name: 'Birdie Golf',
  timezone: 'Asia/Amman',
  services: [
    { id: 1,  name: 'Sim Bay 1', duration_minutes: 60,  currency_code: 'JD' },
    { id: 16, name: 'Karaoke',   duration_minutes: 120, currency_code: 'JD' },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// Codepoint-assertion — locks every Arabic literal to its expected sequence.
// ════════════════════════════════════════════════════════════════════════════
describe('Arabic literals — codepoint lock', () => {
  test('formatPaymentMethod AR mappings are exactly the expected codepoints', () => {
    expect(codepoints(_formatPaymentMethod('cash', 'ar')))
      .toBe('U+0646 U+0642 U+062F U+0627 U+064B');
    expect(codepoints(_formatPaymentMethod('card', 'ar')))
      .toBe('U+0628 U+0637 U+0627 U+0642 U+0629');
    expect(codepoints(_formatPaymentMethod('membership', 'ar')))
      .toBe('U+0627 U+0634 U+062A U+0631 U+0627 U+0643');
    expect(codepoints(_formatPaymentMethod('package', 'ar')))
      .toBe('U+0628 U+0627 U+0642 U+0629');
    expect(codepoints(_formatPaymentMethod('cliq', 'ar')))
      .toBe('U+0043 U+006C U+0069 U+0051');
  });

  test('AR_CONFIRM_KEYWORDS whitelist source is the exact codepoint sequence', () => {
    // أؤكد | أحجز | نؤكد | تأكيد
    // The 'we confirm' token MUST use U+0624 (hamza-on-WAAW), not U+0623.
    expect(codepoints(_patterns.AR_CONFIRM_KEYWORDS.source))
      .toBe(
        // أؤكد
        'U+0623 U+0624 U+0643 U+062F U+007C '
        // أحجز
        + 'U+0623 U+062D U+062C U+0632 U+007C '
        // نؤكد (hamza-on-waaw)
        + 'U+0646 U+0624 U+0643 U+062F U+007C '
        // تأكيد
        + 'U+062A U+0623 U+0643 U+064A U+062F'
      );
  });

  test('AR_TIME_MARKER whitelist source is the exact codepoint sequence', () => {
    // صباح | مساء | ليل | ظهر
    expect(codepoints(_patterns.AR_TIME_MARKER.source))
      .toBe(
        // صباح
        'U+0635 U+0628 U+0627 U+062D U+007C '
        // مساء
        + 'U+0645 U+0633 U+0627 U+0621 U+007C '
        // ليل
        + 'U+0644 U+064A U+0644 U+007C '
        // ظهر
        + 'U+0638 U+0647 U+0631'
      );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Threshold P — hasRecentPendingBooking (lenient)
// ════════════════════════════════════════════════════════════════════════════
describe('Threshold P — hasRecentPendingBooking', () => {
  test('EN positive: confirm-kw + trailing ? → true', () => {
    expect(hasRecentPendingBooking([asst('Sim Bay 1 at 8:00 PM. Shall I confirm?')])).toBe(true);
  });
  test('AR positive: أؤكد + trailing ؟ → true', () => {
    expect(hasRecentPendingBooking([asst('هل أؤكد الحجز؟')])).toBe(true);
  });
  test('Missing ? → false (EN)', () => {
    expect(hasRecentPendingBooking([asst('Shall I confirm')])).toBe(false);
  });
  test('Missing confirm-kw → false', () => {
    expect(hasRecentPendingBooking([asst('Looking that up for you?')])).toBe(false);
  });
  test('Empty history → false', () => {
    expect(hasRecentPendingBooking([])).toBe(false);
    expect(hasRecentPendingBooking(null)).toBe(false);
    expect(hasRecentPendingBooking(undefined)).toBe(false);
  });
  test('Only user turns → false (no assistant turn)', () => {
    expect(hasRecentPendingBooking([user('yes confirm'), user('please')])).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Threshold G — priorAssistantTurnHasConcreteProposal (strict)
// ════════════════════════════════════════════════════════════════════════════
describe('Threshold G — priorAssistantTurnHasConcreteProposal', () => {
  test('EN positive: confirm-kw + clock-time + ? → true', () => {
    expect(priorAssistantTurnHasConcreteProposal([asst('Sim Bay 1 at 8:00 PM, cash. Shall I confirm?')])).toBe(true);
  });
  test('AR positive (Latin digits + AR PM marker): true', () => {
    expect(priorAssistantTurnHasConcreteProposal(
      [asst('عند الساعة 8:00 مساءً، نقداً. هل أؤكد الحجز؟')]
    )).toBe(true);
  });
  test('AR positive (Arabic-Indic digits): true', () => {
    // ٨:٠٠ = U+0668 U+003A U+0660 U+0660 — CLOCK_TIME regex accepts ٠-٩ class.
    expect(priorAssistantTurnHasConcreteProposal(
      [asst('عند الساعة ٨:٠٠ مساءً. هل أؤكد؟')]
    )).toBe(true);
  });
  test('Strictness: P=true, G=false for time-less proposal', () => {
    const history = [asst('Shall I confirm your booking?')];
    expect(hasRecentPendingBooking(history)).toBe(true);
    expect(priorAssistantTurnHasConcreteProposal(history)).toBe(false);
  });
  test('Missing ? → false (otherwise valid)', () => {
    expect(priorAssistantTurnHasConcreteProposal([asst('Sim Bay 1 at 8:00 PM. Shall I confirm')])).toBe(false);
  });
  test('Missing confirm-kw → false', () => {
    expect(priorAssistantTurnHasConcreteProposal([asst('You have a booking at 8:00 PM. Want a different time?')])).toBe(false);
  });
  test('Missing clock-time → false', () => {
    expect(priorAssistantTurnHasConcreteProposal([asst('Shall I confirm your booking?')])).toBe(false);
  });
  test('1-entry scan: only the LAST assistant turn is scanned (stale -2 ignored)', () => {
    // Last assistant turn (most recent) is a non-proposal — G must fail
    // EVEN IF a stale proposal exists earlier in history.
    const history = [
      asst('Sim Bay 1 at 8:00 PM. Shall I confirm?'),  // stale proposal at -2
      user('actually 9pm'),
      asst('Got it, let me check 9pm. Want me to switch?'),  // last assistant, time but no confirm-kw
    ];
    expect(priorAssistantTurnHasConcreteProposal(history)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Composite — hasCreateBookingApproval (TWO-FACTOR truth table)
// ════════════════════════════════════════════════════════════════════════════
describe('hasCreateBookingApproval — two-factor truth table', () => {
  const proposalHist = [asst('Sim Bay 1 at 8:00 PM. Shall I confirm?')];
  const noPropHist   = [asst('Hi! What can I help with?')];
  const cbAction     = { type: 'create_booking', service_id: 1, start_time: 'x' };

  test('sidecar + confirmation=true → true', () => {
    expect(hasCreateBookingApproval({
      pendingAction: cbAction, confirmationMode: true, history: [],
    })).toBe(true);
  });
  test('sidecar + confirmation=false → false (BOTH factors required)', () => {
    expect(hasCreateBookingApproval({
      pendingAction: cbAction, confirmationMode: false, history: [],
    })).toBe(false);
  });
  test('no sidecar + confirmation=true + G passes → true (legacy fallback)', () => {
    expect(hasCreateBookingApproval({
      pendingAction: null, confirmationMode: true, history: proposalHist,
    })).toBe(true);
  });
  test('no sidecar + confirmation=true + G fails → false', () => {
    expect(hasCreateBookingApproval({
      pendingAction: null, confirmationMode: true, history: noPropHist,
    })).toBe(false);
  });
  test('no sidecar + confirmation=false + G passes → false', () => {
    expect(hasCreateBookingApproval({
      pendingAction: null, confirmationMode: false, history: proposalHist,
    })).toBe(false);
  });
  test('pendingAction with type≠create_booking + confirmation=true → false', () => {
    expect(hasCreateBookingApproval({
      pendingAction: { type: 'cancel_booking', booking_id: 42 },
      confirmationMode: true,
      history: [],
    })).toBe(false);
  });
  test('null history + confirmation=true + no sidecar → false', () => {
    expect(hasCreateBookingApproval({
      pendingAction: null, confirmationMode: true, history: null,
    })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// transformDroppedToProposal
// ════════════════════════════════════════════════════════════════════════════
describe('transformDroppedToProposal', () => {
  test('create_booking action → confirm_proposal shape with the same params', () => {
    const action = {
      type: 'create_booking',
      service_id: 1,
      start_time: '2026-05-28T17:00:00Z',
      duration_minutes: 60,
      resource_id: 5,
      staff_id: null,
      payment_method: 'cash',
      membership_id: null,
      prepaid_entitlement_id: null,
      slots: 1,
    };
    expect(transformDroppedToProposal(action)).toEqual({
      intent: 'clarify',
      action: null,
      answer: {
        kind: 'confirm_proposal',
        payload: {
          service_id: 1,
          start_time: '2026-05-28T17:00:00Z',
          duration_minutes: 60,
          resource_id: 5,
          staff_id: null,
          payment_method: 'cash',
          membership_id: null,
          prepaid_entitlement_id: null,
          slots: 1,
        },
      },
    });
  });
  test('null / undefined action → null', () => {
    expect(transformDroppedToProposal(null)).toBe(null);
    expect(transformDroppedToProposal(undefined)).toBe(null);
  });
  test('non-create_booking action → null', () => {
    expect(transformDroppedToProposal({ type: 'check_availability', date: 'x' })).toBe(null);
    expect(transformDroppedToProposal({ type: 'cancel_booking', booking_id: 1 })).toBe(null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// executeActionWithGate — handleAction spy
// ════════════════════════════════════════════════════════════════════════════
describe('executeActionWithGate — handleAction call-count + args', () => {
  const cbAction = {
    type: 'create_booking',
    service_id: 1,
    start_time: '2026-05-28T17:00:00Z',
    duration_minutes: 60,
    payment_method: 'cash',
  };
  const ctx = {
    tenantId: 3, tenantSlug: 'birdie-golf', customerId: 99,
    email: 'x@y.com', authToken: 'tok-x',
  };

  test('drop: handleAction NOT called; returns dropped marker', async () => {
    const handleAction = jest.fn();
    const result = await executeActionWithGate({
      action: cbAction,
      isApprovedForCreateBooking: false,
      handleAction,
      context: ctx,
      logger: { warn: () => {}, log: () => {} },
    });
    expect(handleAction).toHaveBeenCalledTimes(0);
    expect(result).toEqual({
      success: false,
      dropped: true,
      reason: 'no_approval_signal',
      message: 'Booking not yet confirmed — re-proposed for explicit approval.',
    });
  });

  test('approve: handleAction called exactly once with exact args', async () => {
    const handleAction = jest.fn().mockResolvedValue({ success: true, bookingId: 999 });
    const result = await executeActionWithGate({
      action: cbAction,
      isApprovedForCreateBooking: true,
      handleAction,
      context: ctx,
    });
    expect(handleAction).toHaveBeenCalledTimes(1);
    expect(handleAction).toHaveBeenCalledWith(
      cbAction,
      ctx.tenantId,
      ctx.tenantSlug,
      ctx.customerId,
      ctx.email,
      ctx.authToken,
    );
    expect(result).toEqual({ success: true, bookingId: 999 });
  });

  test('non-create_booking action bypasses gate (auth not required)', async () => {
    const handleAction = jest.fn().mockResolvedValue({ success: true, slots: [] });
    const availAction = { type: 'check_availability', date: '2026-05-28' };
    await executeActionWithGate({
      action: availAction,
      isApprovedForCreateBooking: false, // irrelevant
      handleAction,
      context: ctx,
    });
    expect(handleAction).toHaveBeenCalledTimes(1);
    expect(handleAction).toHaveBeenCalledWith(availAction, ctx.tenantId, ctx.tenantSlug, ctx.customerId, ctx.email, ctx.authToken);
  });

  test('null action → returns null, handleAction not called', async () => {
    const handleAction = jest.fn();
    const result = await executeActionWithGate({
      action: null,
      isApprovedForCreateBooking: true,
      handleAction,
      context: ctx,
    });
    expect(result).toBe(null);
    expect(handleAction).toHaveBeenCalledTimes(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// formatDeterministicReProposeReply — content shape (EN/AR × morning/evening/missing)
// ════════════════════════════════════════════════════════════════════════════
describe('formatDeterministicReProposeReply — content shape', () => {
  // 17:00Z = 8:00 PM in Asia/Amman (UTC+3); 04:00Z = 7:00 AM Amman
  const eveningPayload = {
    service_id: 1, start_time: '2026-05-28T17:00:00Z',
    duration_minutes: 60, payment_method: 'cash',
  };
  const morningPayload = {
    ...eveningPayload, start_time: '2026-05-28T04:00:00Z',
  };
  const missingFieldsPayload = {
    service_id: 999, // not in BIRDIE_CTX → falls back to service-name default
    start_time: null,
    duration_minutes: null,
    payment_method: null,
  };

  test('EN evening: contains "Shall I confirm?" + service name + PM time', () => {
    const out = formatDeterministicReProposeReply({
      payload: eveningPayload, tenantContext: BIRDIE_CTX, language: 'en',
    });
    expect(out).toContain('Sim Bay 1');
    expect(out).toContain('8:00 PM');
    expect(out).toContain('cash');
    expect(out).toContain('Shall I confirm?');
    expect(out.endsWith('?')).toBe(true);
  });

  test('EN morning: AM time, EN keywords intact', () => {
    const out = formatDeterministicReProposeReply({
      payload: morningPayload, tenantContext: BIRDIE_CTX, language: 'en',
    });
    expect(out).toContain('7:00 AM');
    expect(out).toContain('Shall I confirm?');
  });

  test('EN missing fields: service-name fallback "the service", default duration 60', () => {
    const out = formatDeterministicReProposeReply({
      payload: missingFieldsPayload, tenantContext: BIRDIE_CTX, language: 'en',
    });
    expect(out).toContain('the service');
    expect(out).toContain('60 minutes');
    expect(out).toContain('12:00 AM'); // fallback when start_time null
    expect(out).toContain('cash');     // fallback when payment_method null
    expect(out.endsWith('?')).toBe(true);
  });

  test('AR evening: contains أؤكد + ؟ + مساءً + Latin clock-time', () => {
    const out = formatDeterministicReProposeReply({
      payload: eveningPayload, tenantContext: BIRDIE_CTX, language: 'ar',
    });
    expect(out).toContain('Sim Bay 1');
    expect(out).toContain('8:00');
    expect(out).toContain('مساءً');  // PM marker
    expect(out).toContain('نقداً');     // cash
    expect(out).toContain('أؤكد');   // confirm-kw
    expect(out).toContain('الحجز');  // الحجز
    expect(out.endsWith('؟')).toBe(true);
  });

  test('AR morning: contains صباحاً', () => {
    const out = formatDeterministicReProposeReply({
      payload: morningPayload, tenantContext: BIRDIE_CTX, language: 'ar',
    });
    expect(out).toContain('7:00');
    expect(out).toContain('صباحاً'); // AM marker
    expect(out).toContain('أؤكد');
    expect(out.endsWith('؟')).toBe(true);
  });

  test('AR missing fields: fallback service name الخدمة + default time + cash + ?', () => {
    const out = formatDeterministicReProposeReply({
      payload: missingFieldsPayload, tenantContext: BIRDIE_CTX, language: 'ar',
    });
    expect(out).toContain('الخدمة');     // fallback service name
    expect(out).toContain('12:00');
    expect(out).toContain('صباحاً');
    expect(out).toContain('نقداً');
    expect(out).toContain('أؤكد');
    expect(out.endsWith('؟')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RECOVERY TEMPLATE PIN — load-bearing CI invariant.
// REAL builder output × lang × time-format × payment-method.
// Asserts every combo passes Threshold G AND hasCreateBookingApproval with
// confirmationMode=true. A template edit that drifts outside the whitelist
// fails CI here.
// ════════════════════════════════════════════════════════════════════════════
describe('RECOVERY TEMPLATE PIN — real builder × G gate', () => {
  // 3 time slices × 2 payment methods × 2 languages = 12 combos.
  // Plus an Arabic-Indic-digit variant of the AR cases (the gate's CLOCK_TIME
  // accepts U+0660-U+0669 — exercise that path).
  const slots = [
    { label: 'morning-AM',  isoUtc: '2026-05-28T04:00:00Z' }, // 7:00 AM Amman
    { label: 'evening-PM',  isoUtc: '2026-05-28T17:00:00Z' }, // 8:00 PM Amman
    { label: 'midnight',    isoUtc: '2026-05-28T21:00:00Z' }, // 12:00 AM Amman next day
  ];
  const payments = ['cash', 'membership'];
  const langs    = ['en', 'ar'];

  for (const lang of langs) {
    for (const slot of slots) {
      for (const pm of payments) {
        test(`pin ${lang} × ${slot.label} × ${pm} — real output passes G + composite`, () => {
          const payload = {
            service_id: 1,
            start_time: slot.isoUtc,
            duration_minutes: 60,
            payment_method: pm,
          };
          const reply = formatDeterministicReProposeReply({
            payload, tenantContext: BIRDIE_CTX, language: lang,
          });
          const history = [asst(reply)];
          expect(priorAssistantTurnHasConcreteProposal(history)).toBe(true);
          expect(hasCreateBookingApproval({
            pendingAction: null,
            confirmationMode: true,
            history,
          })).toBe(true);
        });
      }
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// No-infinite-loop integration: drop → deterministic prose → next-turn gate
// passes → handleAction called exactly once across the pair.
// ════════════════════════════════════════════════════════════════════════════
describe('integration — drop then approve calls handleAction exactly once', () => {
  test('two turns: drop emits prose, next turn with confirmationMode passes the gate', async () => {
    const cbAction = {
      type: 'create_booking',
      service_id: 1,
      start_time: '2026-05-28T17:00:00Z',
      duration_minutes: 60,
      payment_method: 'cash',
    };
    const ctx = {
      tenantId: 3, tenantSlug: 'birdie-golf', customerId: 99,
      email: 'x@y.com', authToken: 'tok-x',
    };
    const handleAction = jest.fn().mockResolvedValue({ success: true, bookingId: 999 });

    // Turn N: gate drops (no approval signal yet). Build refreshed sidecar
    // + deterministic re-propose reply (mirrors what routes/ai.js +
    // routes/voice.js do on drop).
    const turnN = await executeActionWithGate({
      action: cbAction,
      isApprovedForCreateBooking: false,
      handleAction,
      context: ctx,
      logger: { warn: () => {}, log: () => {} },
    });
    expect(turnN).toMatchObject({ dropped: true, reason: 'no_approval_signal' });
    expect(handleAction).toHaveBeenCalledTimes(0);

    const proposed = transformDroppedToProposal(cbAction);
    const reply = formatDeterministicReProposeReply({
      payload: proposed.answer.payload,
      tenantContext: BIRDIE_CTX,
      language: 'en',
    });
    const historyAfterTurnN = [asst(reply)];

    // Turn N+1: customer signals confirmation. The gate composite passes
    // (legacy fallback path: confirmation + G on the recovery prose).
    const isApproved = hasCreateBookingApproval({
      pendingAction: null,
      confirmationMode: true,
      history: historyAfterTurnN,
    });
    expect(isApproved).toBe(true);

    const turnN1 = await executeActionWithGate({
      action: cbAction,
      isApprovedForCreateBooking: isApproved,
      handleAction,
      context: ctx,
    });
    expect(turnN1).toEqual({ success: true, bookingId: 999 });
    expect(handleAction).toHaveBeenCalledTimes(1);
  });
});
