'use strict';

// Phase 2.1 — Voice agent brain unit tests (10 cases).
//
// Boundary tests on utils/bookingBrain.js. The brain is UNWIRED in 2.1
// (no production code path calls it) — these tests run it in isolation
// to lock in the contract before the orchestrator wire-up in 2.3.
//
// Critical: the 4 production bugs each have a STRUCTURAL fallback in the
// brain's parsing layer, not just a prompt rule. Tests B4 (CONFLICT),
// B5 (PAYMENT ELIGIBILITY), and a structural facet of B9 verify those
// fallbacks fire even when the LLM regresses on the prompt rule.

// ── Mocks (must be declared before requires) ────────────────────────────
const mockClaudeCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockClaudeCreate },
  }));
});

const {
  runBookingBrain,
  _computePersonalization,
  _parseBrainOutput,
  _applyStructuralFallbacks,
  _detectUpcomingConflict,
} = require('../utils/bookingBrain');

// ── Helpers ─────────────────────────────────────────────────────────────
function claudeJson(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
function claudeText(text) {
  return { content: [{ type: 'text', text }] };
}
function futureISO(daysAhead = 2, hour = 20, minute = 0) {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

const TENANT_KARAOKE = {
  id: 1,
  name: 'Birdie Golf',
  timezone: 'Asia/Amman',
  services: [
    { id: 16, name: 'Karaoke', duration_minutes: 120, slot_interval_minutes: 60, allow_membership: true, currency_code: 'JD', price: 17.5 },
  ],
  resourceLinks: [
    { service_id: 16, resource_id: 1, resource_name: 'Sim 1' },
    { service_id: 16, resource_id: 2, resource_name: 'Sim 2' },
    { service_id: 16, resource_id: 3, resource_name: 'Sim 3' },
  ],
  staffLinks: [],
};

beforeEach(() => {
  mockClaudeCreate.mockReset();
});

// ════════════════════════════════════════════════════════════════════════
// B1 — check_availability
// ════════════════════════════════════════════════════════════════════════
describe('B1 — check_availability', () => {
  test('returns intent=check_availability with action populated, no fabricated resource_id', async () => {
    const tomorrow = new Date(Date.now() + 86400000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Amman' });
    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'check_availability',
      action: { type: 'check_availability', service_id: 16, date: tomorrow, resource_id: null, staff_id: null },
      answer: null,
    }));

    const result = await runBookingBrain({
      tenantContext: TENANT_KARAOKE,
      customerData: null,
      isSignedIn: false,
      history: [],
      message: "what's available tomorrow for karaoke",
    });

    expect(result.intent).toBe('check_availability');
    expect(result.action).toEqual(expect.objectContaining({
      type: 'check_availability',
      service_id: 16,
      date: tomorrow,
      resource_id: null,
    }));
    expect(result.answer).toBeNull();
    expect(result.personalization).toEqual(expect.objectContaining({
      bookingsCountLast90Days: 0,
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════
// B2 — confirmation flow (confirmationMode=true → create_booking)
// ════════════════════════════════════════════════════════════════════════
describe('B2 — confirmation flow', () => {
  test('emits create_booking carrying payment_method from prior turn when confirmationMode=true', async () => {
    const start = futureISO(2, 17, 0);
    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'create_booking',
      action: {
        type: 'create_booking',
        service_id: 16,
        start_time: start,
        duration_minutes: 120,
        resource_id: 1,
        staff_id: null,
        payment_method: 'cash',
        membership_id: null,
        prepaid_entitlement_id: null,
        slots: 2,
      },
      answer: null,
    }));

    const result = await runBookingBrain({
      tenantContext: TENANT_KARAOKE,
      customerData: { profile: { id: 99 }, bookings: [], memberships: [], packages: [] },
      isSignedIn: true,
      history: [
        { role: 'user', content: 'book sim 1 at 5pm cash for 2 hours' },
        { role: 'assistant', content: 'Sim 1 at 5pm for 2hr, cash — confirm?' },
      ],
      message: 'yes',
      confirmationMode: true,
    });

    expect(result.intent).toBe('create_booking');
    expect(result.action).toEqual(expect.objectContaining({
      type: 'create_booking',
      service_id: 16,
      payment_method: 'cash',
      resource_id: 1,
    }));

    // Confirmation note is injected into the last user message (system prompt
    // stays stable for caching).
    const lastCall = mockClaudeCreate.mock.calls[0][0];
    const lastUserMsg = lastCall.messages[lastCall.messages.length - 1];
    expect(lastUserMsg.role).toBe('user');
    expect(lastUserMsg.content).toMatch(/confirmationMode=true/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// B3 — bare "yes" without a recent proposal
// ════════════════════════════════════════════════════════════════════════
describe('B3 — bare yes without proposal', () => {
  test('does not auto-create_booking when confirmationMode=false', async () => {
    // Brain returns clarify because there is no proposal in scope.
    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'clarify',
      action: null,
      answer: { kind: 'need_proposal', payload: {} },
    }));

    const result = await runBookingBrain({
      tenantContext: TENANT_KARAOKE,
      customerData: null,
      isSignedIn: false,
      history: [],
      message: 'yes',
      confirmationMode: false,
    });

    expect(result.intent).not.toBe('create_booking');
    expect(result.action).toBeNull();
    expect(result.answer?.kind).toBe('need_proposal');
  });
});

// ════════════════════════════════════════════════════════════════════════
// B4 — CONFLICT structural fallback (Bug B)
// ════════════════════════════════════════════════════════════════════════
describe('B4 — conflict structural fallback', () => {
  test('rewrites create_booking to answer/conflict when proposed time overlaps an UPCOMING booking', async () => {
    // Customer has an upcoming Karaoke booking 20:00 UTC for 120min
    // (ends 22:00 UTC). The mocked LLM wrongly proposes 21:00 UTC for 60min
    // (overlaps 21:00–22:00 with the existing booking). Structural fallback
    // must catch this and rewrite to intent='answer', kind='conflict'.
    const upcomingStart = futureISO(3, 20, 0);
    const conflictingStart = futureISO(3, 21, 0);

    const customerData = {
      profile: { id: 99, name: 'Test', email: 't@x.com' },
      bookings: [{
        id: 555,
        service_id: 16,
        service_name: 'Karaoke',
        start_time: upcomingStart,
        duration_minutes: 120,
        resource_id: 1,
        resource_name: 'Sim 1',
        status: 'confirmed',
      }],
      memberships: [],
      packages: [],
    };

    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'create_booking',
      action: {
        type: 'create_booking',
        service_id: 16,
        start_time: conflictingStart,
        duration_minutes: 60,
        resource_id: 2,
        staff_id: null,
        payment_method: 'cash',
        membership_id: null,
        prepaid_entitlement_id: null,
        slots: 1,
      },
      answer: null,
    }));

    const result = await runBookingBrain({
      tenantContext: TENANT_KARAOKE,
      customerData,
      isSignedIn: true,
      history: [],
      message: 'book me karaoke at 9pm',
    });

    expect(result.intent).toBe('answer');
    expect(result.action).toBeNull();
    expect(result.answer?.kind).toBe('conflict');
    expect(result.answer?.payload).toEqual(expect.objectContaining({
      conflictingBookingId: 555,
      conflictingStartTime: upcomingStart,
      conflictingServiceName: 'Karaoke',
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════
// B5 — PAYMENT ELIGIBILITY structural fallback
// ════════════════════════════════════════════════════════════════════════
describe('B5 — payment eligibility structural fallback', () => {
  test('rewrites to clarify when LLM proposes payment_method=membership on a service that excludes it', async () => {
    // Service 16 has allow_membership=false in this tenantContext.
    const tenant = {
      ...TENANT_KARAOKE,
      services: [{ ...TENANT_KARAOKE.services[0], allow_membership: false }],
    };

    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'create_booking',
      action: {
        type: 'create_booking',
        service_id: 16,
        start_time: futureISO(2, 17, 0),
        duration_minutes: 120,
        resource_id: 1,
        staff_id: null,
        payment_method: 'membership',
        membership_id: 7,
        prepaid_entitlement_id: null,
        slots: 2,
      },
      answer: null,
    }));

    const customerData = {
      profile: { id: 99 },
      bookings: [],
      memberships: [{ id: 7, status: 'active', plan_name: 'Gold', minutes_remaining: 500 }],
      packages: [],
    };

    const result = await runBookingBrain({
      tenantContext: tenant,
      customerData,
      isSignedIn: true,
      history: [],
      message: 'book karaoke and use my membership',
      confirmationMode: true,
    });

    expect(result.intent).toBe('clarify');
    expect(result.action).toBeNull();
    expect(result.answer?.kind).toBe('payment_method_invalid');
    expect(result.answer?.payload).toEqual(expect.objectContaining({
      service_id: 16,
      payment_method: 'membership',
      reason: 'service_excludes_membership',
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════
// B6 — personalization (usual resource from recent past)
// ════════════════════════════════════════════════════════════════════════
describe('B6 — personalization (hint, not command)', () => {
  test('populates usualResourceId from 5 recent Sim 3 bookings; brain does NOT pre-fill resource_id', async () => {
    // Mock returns a clarify (asks for time) — does NOT pre-fill resource.
    // Personalization is a separate signal on the brain output.
    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'clarify',
      action: null,
      answer: { kind: 'need_time', payload: { service_id: 16 } },
    }));

    const customerData = {
      profile: { id: 99, name: 'Test', email: 't@x.com' },
      bookings: Array.from({ length: 5 }, (_, i) => ({
        id: 100 + i,
        service_id: 16,
        service_name: 'Karaoke',
        resource_id: 3,
        resource_name: 'Sim 3',
        // Each one (i+1) weeks ago — all inside 90 days
        start_time: new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 120,
        status: 'confirmed',
      })),
      memberships: [],
      packages: [],
    };

    const result = await runBookingBrain({
      tenantContext: TENANT_KARAOKE,
      customerData,
      isSignedIn: true,
      history: [],
      message: 'book me a sim tonight',
    });

    expect(result.personalization.usualResourceId).toBe(3);
    expect(result.personalization.usualResourceName).toBe('Sim 3');
    expect(result.personalization.bookingsCountLast90Days).toBe(5);
    expect(result.personalization.lastBookingId).toBe(100); // most recent
    expect(result.personalization.lastBookingServiceId).toBe(16);
    // Brain does NOT pre-fill resource_id when intent is clarify
    expect(result.action).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// B7 — cancel_booking
// ════════════════════════════════════════════════════════════════════════
describe('B7 — cancel_booking', () => {
  test('passes through cancel_booking with booking_id', async () => {
    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'cancel_booking',
      action: { type: 'cancel_booking', booking_id: 456 },
      answer: null,
    }));

    const result = await runBookingBrain({
      tenantContext: TENANT_KARAOKE,
      customerData: { profile: { id: 99 }, bookings: [], memberships: [], packages: [] },
      isSignedIn: true,
      history: [],
      message: 'cancel booking 456',
    });

    expect(result.intent).toBe('cancel_booking');
    expect(result.action).toEqual({ type: 'cancel_booking', booking_id: 456 });
    expect(result.answer).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// B8 — parse failure recovery
// ════════════════════════════════════════════════════════════════════════
describe('B8 — parse failure recovery', () => {
  test('returns clarify with kind=parse_failure when LLM emits prose without JSON', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText(
      "Sure thing! I'll help you book that.",
    ));

    const result = await runBookingBrain({
      tenantContext: TENANT_KARAOKE,
      customerData: null,
      isSignedIn: false,
      history: [],
      message: 'hi',
    });

    expect(result.intent).toBe('clarify');
    expect(result.action).toBeNull();
    expect(result.answer?.kind).toBe('parse_failure');
    expect(result.answer?.payload?.rawHead).toMatch(/Sure thing/);
    // The brain MUST always return personalization, even on parse failure
    expect(result.personalization).toEqual(expect.objectContaining({
      bookingsCountLast90Days: 0,
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════
// B9 — resource ambiguous (inverse of B6)
// ════════════════════════════════════════════════════════════════════════
describe('B9 — ambiguous resource selection', () => {
  test('emits clarify with kind=resource_ambiguous when service has multi resources and no preference history', async () => {
    // Tenant context has Karaoke with 5 linked resources.
    const tenant = {
      ...TENANT_KARAOKE,
      resourceLinks: [
        { service_id: 16, resource_id: 1, resource_name: 'Sim 1' },
        { service_id: 16, resource_id: 2, resource_name: 'Sim 2' },
        { service_id: 16, resource_id: 3, resource_name: 'Sim 3' },
        { service_id: 16, resource_id: 4, resource_name: 'Sim 4' },
        { service_id: 16, resource_id: 5, resource_name: 'Sim 5' },
      ],
    };
    // Customer has NO history → personalization signal is null.
    const customerData = {
      profile: { id: 99, name: 'New User' },
      bookings: [],
      memberships: [],
      packages: [],
    };

    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'clarify',
      action: null,
      answer: {
        kind: 'resource_ambiguous',
        payload: { service_id: 16, candidate_resource_ids: [1, 2, 3, 4, 5] },
      },
    }));

    const result = await runBookingBrain({
      tenantContext: tenant,
      customerData,
      isSignedIn: true,
      history: [],
      message: 'book me a sim at 5pm',
    });

    expect(result.intent).toBe('clarify');
    expect(result.action).toBeNull();
    expect(result.answer?.kind).toBe('resource_ambiguous');
    expect(result.answer?.payload?.candidate_resource_ids).toEqual([1, 2, 3, 4, 5]);
    // No personalization signal because no history (lock-in: personalization is hint, not command)
    expect(result.personalization.usualResourceId).toBeNull();
    expect(result.personalization.usualResourceName).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// B10 — latency benchmark (wrapper overhead)
// ════════════════════════════════════════════════════════════════════════
describe('B10 — latency benchmark', () => {
  test('P90 wrapper overhead with instant mock < 1000ms (production target carried forward separately)', async () => {
    // Instant-resolving Claude mock — measures ONLY the brain's wrapper
    // overhead (prompt build, JSON parse, structural fallbacks, normalize).
    // Production P90 < 1000ms must still be validated against real Claude
    // latency in 2.3 deploy; this test guards against pathological wrapper
    // regressions (sync DB calls, loops, etc.) before that point.
    mockClaudeCreate.mockResolvedValue(claudeJson({
      intent: 'answer',
      action: null,
      answer: { kind: 'ok', payload: {} },
    }));

    const N = 20;
    const timings = [];
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await runBookingBrain({
        tenantContext: TENANT_KARAOKE,
        customerData: null,
        isSignedIn: false,
        history: [],
        message: 'hi',
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
// Direct unit tests on internal helpers — verify the structural layer in
// isolation, not just through the LLM mock indirection.
// ════════════════════════════════════════════════════════════════════════
describe('internal helpers', () => {
  test('_computePersonalization returns defaults for null/undefined customer', () => {
    expect(_computePersonalization(null)).toEqual({
      usualResourceId: null,
      usualResourceName: null,
      lastBookingId: null,
      lastBookingServiceId: null,
      bookingsCountLast90Days: 0,
    });
    expect(_computePersonalization(undefined)).toEqual({
      usualResourceId: null,
      usualResourceName: null,
      lastBookingId: null,
      lastBookingServiceId: null,
      bookingsCountLast90Days: 0,
    });
  });

  test('_computePersonalization usualResource only surfaces at 3+ bookings', () => {
    const cust = (n) => ({
      bookings: Array.from({ length: n }, (_, i) => ({
        id: i + 1, service_id: 16, resource_id: 3, resource_name: 'Sim 3',
        start_time: new Date(Date.now() - (i + 1) * 7 * 86400000).toISOString(),
        status: 'confirmed', duration_minutes: 60,
      })),
    });
    expect(_computePersonalization(cust(2)).usualResourceId).toBeNull();
    expect(_computePersonalization(cust(3)).usualResourceId).toBe(3);
    expect(_computePersonalization(cust(3)).usualResourceName).toBe('Sim 3');
  });

  test('_parseBrainOutput handles bare JSON, markdown fences, prose preamble, and pure prose', () => {
    expect(_parseBrainOutput('{"intent":"answer","action":null,"answer":null}')).toEqual({
      intent: 'answer', action: null, answer: null,
    });
    expect(_parseBrainOutput('```json\n{"intent":"answer","action":null,"answer":null}\n```')).toEqual({
      intent: 'answer', action: null, answer: null,
    });
    expect(_parseBrainOutput('Sure! {"intent":"answer","action":null,"answer":null}')).toEqual({
      intent: 'answer', action: null, answer: null,
    });
    expect(_parseBrainOutput('Sure thing.')).toBeNull();
    expect(_parseBrainOutput('')).toBeNull();
    expect(_parseBrainOutput(null)).toBeNull();
  });

  test('_detectUpcomingConflict returns null when no overlap; returns the booking on overlap', () => {
    const upcomingStart = futureISO(3, 20, 0);
    const customerData = {
      bookings: [{
        id: 555, start_time: upcomingStart, duration_minutes: 120,
        status: 'confirmed', service_name: 'Karaoke',
      }],
    };
    // No overlap: proposed runs 18:00–19:00, existing runs 20:00–22:00
    expect(_detectUpcomingConflict({
      action: { start_time: futureISO(3, 18, 0), duration_minutes: 60 },
      customerData,
    })).toBeNull();
    // Overlap: proposed runs 21:00–22:00, existing 20:00–22:00
    const c = _detectUpcomingConflict({
      action: { start_time: futureISO(3, 21, 0), duration_minutes: 60 },
      customerData,
    });
    expect(c?.id).toBe(555);
    // Cancelled bookings are ignored
    expect(_detectUpcomingConflict({
      action: { start_time: futureISO(3, 21, 0), duration_minutes: 60 },
      customerData: { bookings: [{ ...customerData.bookings[0], status: 'cancelled' }] },
    })).toBeNull();
  });

  test('_applyStructuralFallbacks passes through when no rule fires', () => {
    const input = {
      intent: 'check_availability',
      action: { type: 'check_availability', service_id: 16, date: '2026-05-20', resource_id: null, staff_id: null },
      answer: null,
    };
    expect(_applyStructuralFallbacks({
      parsed: input,
      tenantContext: TENANT_KARAOKE,
      customerData: null,
    })).toEqual(input);
  });
});
