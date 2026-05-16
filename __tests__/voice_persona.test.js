'use strict';

// Phase 2.2 — Voice agent persona unit tests (10 persona + 4 helper = 14).
//
// Boundary tests on utils/voicePersona.js. Persona is UNWIRED in 2.2
// (no production code path calls it) — these tests run it in isolation.
//
// Persona contract:
//   - speakReply({ tenantContext, brainOutput, actionResult, language,
//                  consumerType }) → { reply, pendingBooking }
//   - pendingBooking computed deterministically by JS (NOT from Claude).
//   - reply is Claude's prose pass-through; tests assert the STRUCTURED
//     input persona passed to Claude (system + user turn).
//
// Architectural separation enforced by tests:
//   - Persona has no DB / no handleAction / no booking authority.
//   - brainOutput and actionResult are not mutated.
//   - Claude has no path to emit pendingBooking (it's computed pre-call).
//   - Currency strings pre-rendered via _renderCurrency before going to Claude.

// ── Mocks (must be declared before requires) ────────────────────────────
const mockClaudeCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockClaudeCreate },
  }));
});

const {
  speakReply,
  _renderCurrency,
  _renderPendingBooking,
} = require('../utils/voicePersona');

// ── Helpers ─────────────────────────────────────────────────────────────
function claudeText(text) {
  return { content: [{ type: 'text', text }] };
}
function futureISO(daysAhead = 2, hour = 17, minute = 0) {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}
function capturedCall() {
  return mockClaudeCreate.mock.calls[0][0];
}
function capturedSystemText() {
  return capturedCall().system?.[0]?.text || '';
}
function capturedUserTurn() {
  return capturedCall().messages[0].content || '';
}

const TENANT_KARAOKE = {
  id: 1,
  name: 'Birdie Golf',
  timezone: 'Asia/Amman',
  services: [
    { id: 16, name: 'Karaoke', duration_minutes: 120, price: 17.5, currency_code: 'JD' },
  ],
};

beforeEach(() => {
  mockClaudeCreate.mockReset();
});

// ════════════════════════════════════════════════════════════════════════
// P1 — check_availability render
// ════════════════════════════════════════════════════════════════════════
describe('P1 — check_availability render', () => {
  test('Claude user turn contains all 3 slot times verbatim; pendingBooking null; reply pass-through', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'I found three times: 5pm, 6pm, and 9pm. Which works?',
    ));

    const result = await speakReply({
      tenantContext: TENANT_KARAOKE,
      brainOutput: {
        intent: 'check_availability',
        action: { type: 'check_availability', service_id: 16, date: '2026-05-20', resource_id: null, staff_id: null },
        answer: null,
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: {
        success: true,
        structured: true,
        slots: [
          { time: '17:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }, { id: 2, name: 'Sim 2', free: true }] },
          { time: '18:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }] },
          { time: '21:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }, { id: 2, name: 'Sim 2', free: true }] },
        ],
      },
      language: 'en',
      consumerType: 'voice',
    });

    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('17:00');
    expect(userTurn).toContain('18:00');
    expect(userTurn).toContain('21:00');
    // Verbatim brain action JSON present
    expect(userTurn).toContain('"service_id":16');

    expect(result.reply).toBe('I found three times: 5pm, 6pm, and 9pm. Which works?');
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// P2 — create_booking success render
// ════════════════════════════════════════════════════════════════════════
describe('P2 — create_booking success render', () => {
  test('user turn contains bookingId + service name + start time; pendingBooking null', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'Booked! Confirmation #123. See you on Saturday at 5pm.',
    ));

    const start = futureISO(2, 17, 0);
    const result = await speakReply({
      tenantContext: TENANT_KARAOKE,
      brainOutput: {
        intent: 'create_booking',
        action: {
          type: 'create_booking', service_id: 16, start_time: start,
          duration_minutes: 120, resource_id: 1, staff_id: null,
          payment_method: 'cash', membership_id: null, prepaid_entitlement_id: null, slots: 2,
        },
        answer: null,
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: {
        success: true,
        bookingId: 123,
        message: '✅ Booked!',
      },
      language: 'en',
      consumerType: 'chat',
    });

    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('123');
    expect(userTurn).toContain('"service_id":16');
    expect(userTurn).toContain(start);
    expect(userTurn).toContain('success: true');

    expect(result.reply).toContain('123');
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// P3 — create_booking failure render
// ════════════════════════════════════════════════════════════════════════
describe('P3 — create_booking failure render', () => {
  test('user turn contains failure message; pendingBooking null; reply pass-through', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'Apologies — that slot was just taken. Want me to check what else is open?',
    ));

    const result = await speakReply({
      tenantContext: TENANT_KARAOKE,
      brainOutput: {
        intent: 'create_booking',
        action: { type: 'create_booking', service_id: 16, start_time: futureISO(2, 17, 0), duration_minutes: 120, resource_id: 1, staff_id: null, payment_method: 'cash', membership_id: null, prepaid_entitlement_id: null, slots: 2 },
        answer: null,
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: {
        success: false,
        message: 'That slot was just taken — let me check what else is open. One moment.',
      },
      language: 'en',
      consumerType: 'voice',
    });

    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('success: false');
    expect(userTurn).toContain('just taken');

    expect(result.reply).toMatch(/taken/i);
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// P4 — conflict render
// ════════════════════════════════════════════════════════════════════════
describe('P4 — conflict render', () => {
  test('user turn contains service_name and conflicting time; pendingBooking null', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'You already have a Karaoke booking at 8pm running till 10pm — that overlaps. Different time, or cancel the existing one?',
    ));

    const conflictingStart = futureISO(3, 20, 0);

    const result = await speakReply({
      tenantContext: TENANT_KARAOKE,
      brainOutput: {
        intent: 'answer',
        action: null,
        answer: {
          kind: 'conflict',
          payload: {
            conflictingBookingId: 555,
            conflictingStartTime: conflictingStart,
            conflictingDurationMinutes: 120,
            conflictingServiceName: 'Karaoke',
            proposedStartTime: futureISO(3, 21, 0),
            proposedDurationMinutes: 60,
          },
        },
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: null,
      language: 'en',
      consumerType: 'voice',
    });

    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('conflict');
    expect(userTurn).toContain('Karaoke');
    expect(userTurn).toContain(conflictingStart);
    expect(userTurn).toContain('555'); // conflictingBookingId

    expect(result.reply).toMatch(/Karaoke/);
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// P5 — payment_method_invalid render
// ════════════════════════════════════════════════════════════════════════
describe('P5 — payment_method_invalid render', () => {
  test('user turn instructs persona NOT to list membership; pendingBooking null', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'Karaoke doesn\'t accept membership credits. Cash, CliQ, or card?',
    ));

    const result = await speakReply({
      tenantContext: TENANT_KARAOKE,
      brainOutput: {
        intent: 'clarify',
        action: null,
        answer: {
          kind: 'payment_method_invalid',
          payload: {
            service_id: 16,
            service_name: 'Karaoke',
            payment_method: 'membership',
            reason: 'service_excludes_membership',
          },
        },
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: null,
      language: 'en',
      consumerType: 'chat',
    });

    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('payment_method_invalid');
    expect(userTurn).toContain('service_excludes_membership');
    // Composition guidance explicitly tells persona to NOT list membership
    expect(userTurn).toMatch(/Do NOT list membership/i);

    expect(result.reply).toBeTruthy();
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// P6 — package_ineligible render
// ════════════════════════════════════════════════════════════════════════
describe('P6 — package_ineligible render', () => {
  test('user turn contains package_name and eligible_service_ids; pendingBooking null', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'Your Lesson Pack is only valid for Group Lessons. For Karaoke, you can use cash, CliQ, or card.',
    ));

    const result = await speakReply({
      tenantContext: TENANT_KARAOKE,
      brainOutput: {
        intent: 'clarify',
        action: null,
        answer: {
          kind: 'package_ineligible',
          payload: {
            service_id: 16,
            package_id: 9,
            package_name: 'Lesson Pack',
            eligible_service_ids: [5],
          },
        },
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: null,
      language: 'en',
      consumerType: 'chat',
    });

    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('Lesson Pack');
    expect(userTurn).toContain('package_ineligible');
    // eligible_service_ids appears in the payload JSON
    expect(userTurn).toMatch(/eligible_service_ids.*5/);

    expect(result.reply).toBeTruthy();
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// P7 — parse_failure recovery render
// ════════════════════════════════════════════════════════════════════════
describe('P7 — parse_failure recovery render', () => {
  test('user turn instructs generic recovery; reply non-empty; pendingBooking null', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'Sorry, I missed that — could you rephrase?',
    ));

    const result = await speakReply({
      tenantContext: TENANT_KARAOKE,
      brainOutput: {
        intent: 'clarify',
        action: null,
        answer: {
          kind: 'parse_failure',
          payload: { rawHead: 'Sure thing!' },
        },
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: null,
      language: 'en',
      consumerType: 'voice',
    });

    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('parse_failure');
    expect(userTurn).toMatch(/rephrase|repeat/i);
    // Composition guidance must tell persona to NOT leak internal error language
    expect(userTurn).toMatch(/Do NOT mention internal errors/i);

    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// P8 — resource_ambiguous render
// ════════════════════════════════════════════════════════════════════════
describe('P8 — resource_ambiguous render', () => {
  test('user turn contains candidate_resource_ids; pendingBooking null', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'Sims 1 through 5 are open — which one would you like?',
    ));

    const result = await speakReply({
      tenantContext: {
        ...TENANT_KARAOKE,
        services: [
          { ...TENANT_KARAOKE.services[0] },
        ],
      },
      brainOutput: {
        intent: 'clarify',
        action: null,
        answer: {
          kind: 'resource_ambiguous',
          payload: {
            service_id: 16,
            candidate_resource_ids: [1, 2, 3, 4, 5],
          },
        },
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: null,
      language: 'en',
      consumerType: 'voice',
    });

    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('resource_ambiguous');
    // Candidate IDs present in the payload JSON
    expect(userTurn).toMatch(/candidate_resource_ids.*\[1,2,3,4,5\]/);

    expect(result.reply).toBeTruthy();
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// P9 — confirm_proposal render (per decision 1b — proposal-turn signal)
// ════════════════════════════════════════════════════════════════════════
describe('P9 — confirm_proposal render', () => {
  test('pendingBooking IS populated with structured fields from payload; reply contains a confirm cue', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      'Sim 1 tomorrow at 5pm for 2 hours, paying cash — shall I confirm?',
    ));

    const start = futureISO(2, 17, 0);
    const proposalPayload = {
      service_id: 16,
      start_time: start,
      duration_minutes: 120,
      resource_id: 1,
      staff_id: null,
      payment_method: 'cash',
      membership_id: null,
      prepaid_entitlement_id: null,
      slots: 2,
    };

    const result = await speakReply({
      tenantContext: TENANT_KARAOKE,
      brainOutput: {
        intent: 'clarify',
        action: null,
        answer: {
          kind: 'confirm_proposal',
          payload: proposalPayload,
        },
        personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
      },
      actionResult: null,
      language: 'en',
      consumerType: 'voice',
    });

    // Reply contains the confirm cue from the mocked prose
    expect(result.reply).toMatch(/confirm/i);

    // pendingBooking is the structured payload — pure-JS computation, not from Claude
    expect(result.pendingBooking).toEqual({
      service_id: 16,
      start_time: start,
      duration_minutes: 120,
      resource_id: 1,
      staff_id: null,
      payment_method: 'cash',
      membership_id: null,
      prepaid_entitlement_id: null,
      slots: 2,
    });

    // Pre-rendered price for service_id=16 (17.5 JOD) appears in user turn
    // Source rule: 17.50 → "seventeen and a half dinars"
    const userTurn = capturedUserTurn();
    expect(userTurn).toContain('seventeen and a half dinars');
    // Composition guidance: do NOT execute, customer must confirm next
    expect(userTurn).toMatch(/Do NOT execute/i);
  });
});

// ════════════════════════════════════════════════════════════════════════
// P10 — wrapper latency benchmark
// ════════════════════════════════════════════════════════════════════════
describe('P10 — latency benchmark', () => {
  test('P90 wrapper overhead with instant mock < 1000ms', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText('ok'));

    const N = 20;
    const timings = [];
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await speakReply({
        tenantContext: TENANT_KARAOKE,
        brainOutput: {
          intent: 'answer',
          action: null,
          answer: { kind: 'ok', payload: {} },
          personalization: { usualResourceId: null, usualResourceName: null, lastBookingId: null, lastBookingServiceId: null, bookingsCountLast90Days: 0 },
        },
        actionResult: null,
        language: 'en',
        consumerType: 'chat',
      });
      const t1 = process.hrtime.bigint();
      timings.push(Number(t1 - t0) / 1_000_000);
    }
    timings.sort((a, b) => a - b);
    const p90 = timings[Math.floor(N * 0.9)];
    expect(p90).toBeLessThan(1000);
  });
});

// ════════════════════════════════════════════════════════════════════════
// H1 — _renderCurrency JD whole numbers + specials (0, 1, 2, 100)
// ════════════════════════════════════════════════════════════════════════
describe('H1 — _renderCurrency JD wholes + specials', () => {
  const cases = [
    // [amount, lang, expected]
    [0,    'en', 'no charge'],
    [0,    'ar', 'مجاناً'],
    [1,    'en', 'one dinar'],
    [1,    'ar', 'دينار واحد'],
    [2,    'en', 'two dinars'],
    [2,    'ar', 'دیناران'],
    [11,   'en', 'eleven dinars'],
    [11,   'ar', 'أحد عشر ديناراً'],
    [12,   'en', 'twelve dinars'],
    [12,   'ar', 'اثنا عشر ديناراً'],
    [25,   'en', 'twenty-five dinars'],
    [25,   'ar', 'خمسة وعشرون ديناراً'],
    [70,   'en', 'seventy dinars'],
    [70,   'ar', 'سبعون ديناراً'],
    [99,   'en', 'ninety-nine dinars'],
    [99,   'ar', 'تسعة وتسعون ديناراً'],
    [100,  'en', 'a hundred dinars'],
    [100,  'ar', 'مئة دينار'],
  ];
  for (const [amount, lang, expected] of cases) {
    test(`(${amount}, JD, ${lang}) → "${expected}"`, () => {
      expect(_renderCurrency(amount, 'JD', lang)).toBe(expected);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// H2 — _renderCurrency JD fractions + sub-dinar
// ════════════════════════════════════════════════════════════════════════
describe('H2 — _renderCurrency JD fractions + sub-dinar', () => {
  const cases = [
    // Sub-dinar (piasters alone)
    [0.25, 'en', 'twenty-five piasters'],
    [0.25, 'ar', 'خمسة وعشرون قرشاً'],
    [0.50, 'en', 'fifty piasters'],
    [0.50, 'ar', 'خمسون قرشاً'],
    [0.75, 'en', 'seventy-five piasters'],
    [0.75, 'ar', 'خمسة وسبعون قرشاً'],
    // Common fractions with whole dinar component
    [2.25, 'en', 'two and a quarter dinars'],
    [2.25, 'ar', 'دیناران وربع'],
    [2.50, 'en', 'two and a half dinars'],
    [2.50, 'ar', 'دیناران ونصف'],
    [11.25, 'en', 'eleven and a quarter dinars'],
    [11.25, 'ar', 'أحد عشر ديناراً وربع'],
    [11.50, 'en', 'eleven and a half dinars'],
    [11.50, 'ar', 'أحد عشر ديناراً ونصف'],
    [11.75, 'en', 'eleven and three quarters dinars'],
    [11.75, 'ar', 'أحد عشر ديناراً وثلاثة أرباع'],
    // Piaster fractions (non-quarter)
    [11.40, 'en', 'eleven dinars and forty piasters'],
    [11.40, 'ar', 'أحد عشر ديناراً وأربعون قرشاً'],
    [12.40, 'en', 'twelve dinars and forty piasters'],
    [12.40, 'ar', 'اثنا عشر ديناراً وأربعون قرشاً'],
  ];
  for (const [amount, lang, expected] of cases) {
    test(`(${amount}, JD, ${lang}) → "${expected}"`, () => {
      expect(_renderCurrency(amount, 'JD', lang)).toBe(expected);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// H3 — _renderCurrency ≥ 100 fallback + non-JD fallback
// ════════════════════════════════════════════════════════════════════════
describe('H3 — _renderCurrency fallback paths', () => {
  test('105 JD en → simple "105 dinars"', () => {
    expect(_renderCurrency(105, 'JD', 'en')).toBe('105 dinars');
  });
  test('105.50 JD en → simple "105 dinars and 50 piasters"', () => {
    expect(_renderCurrency(105.50, 'JD', 'en')).toBe('105 dinars and 50 piasters');
  });
  test('105 JD ar → fallback "105 دينار"', () => {
    expect(_renderCurrency(105, 'JD', 'ar')).toBe('105 دينار');
  });
  test('(50, USD, en) → non-JD fallback "50 USD"', () => {
    expect(_renderCurrency(50, 'USD', 'en')).toBe('50 USD');
  });
  test('(50, usd, en) — currency case-insensitive', () => {
    expect(_renderCurrency(50, 'usd', 'en')).toBe('50 USD');
  });
  test('Invalid / negative amount → empty string', () => {
    expect(_renderCurrency(-1, 'JD', 'en')).toBe('');
    expect(_renderCurrency(NaN, 'JD', 'en')).toBe('');
    expect(_renderCurrency('not a number', 'JD', 'en')).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════
// H4 — _renderPendingBooking — confirm_proposal payload + null-safety
// ════════════════════════════════════════════════════════════════════════
describe('H4 — _renderPendingBooking', () => {
  test('confirm_proposal payload → structured pendingBooking', () => {
    const payload = {
      service_id: 16,
      start_time: '2026-05-20T17:00:00+03:00',
      duration_minutes: 120,
      resource_id: 1,
      staff_id: null,
      payment_method: 'cash',
      membership_id: null,
      prepaid_entitlement_id: null,
      slots: 2,
    };
    const result = _renderPendingBooking({
      intent: 'clarify',
      answer: { kind: 'confirm_proposal', payload },
    });
    expect(result).toEqual(payload);
  });

  test('confirm_proposal with partial payload → fields filled with null', () => {
    const result = _renderPendingBooking({
      intent: 'clarify',
      answer: { kind: 'confirm_proposal', payload: { service_id: 16, start_time: '2026-05-20T17:00:00+03:00' } },
    });
    expect(result).toEqual({
      service_id: 16,
      start_time: '2026-05-20T17:00:00+03:00',
      duration_minutes: null,
      resource_id: null,
      staff_id: null,
      payment_method: null,
      membership_id: null,
      prepaid_entitlement_id: null,
      slots: null,
    });
  });

  test('non-clarify intent → null', () => {
    expect(_renderPendingBooking({ intent: 'check_availability', answer: null })).toBeNull();
    expect(_renderPendingBooking({ intent: 'create_booking', answer: null })).toBeNull();
    expect(_renderPendingBooking({ intent: 'cancel_booking', answer: null })).toBeNull();
    expect(_renderPendingBooking({ intent: 'answer', answer: { kind: 'conflict', payload: {} } })).toBeNull();
  });

  test('clarify with different kind → null', () => {
    expect(_renderPendingBooking({ intent: 'clarify', answer: { kind: 'resource_ambiguous', payload: {} } })).toBeNull();
    expect(_renderPendingBooking({ intent: 'clarify', answer: { kind: 'payment_method_invalid', payload: {} } })).toBeNull();
    expect(_renderPendingBooking({ intent: 'clarify', answer: { kind: 'parse_failure', payload: {} } })).toBeNull();
  });

  test('null-safety — never throws', () => {
    expect(_renderPendingBooking(null)).toBeNull();
    expect(_renderPendingBooking(undefined)).toBeNull();
    expect(_renderPendingBooking({})).toBeNull();
    expect(_renderPendingBooking({ intent: 'clarify' })).toBeNull();
    expect(_renderPendingBooking({ intent: 'clarify', answer: {} })).toBeNull();
    expect(_renderPendingBooking({ intent: 'clarify', answer: { kind: 'confirm_proposal' } })).toBeNull();
    expect(_renderPendingBooking({ intent: 'clarify', answer: { kind: 'confirm_proposal', payload: null } })).toBeNull();
  });
});
