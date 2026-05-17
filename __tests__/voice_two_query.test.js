'use strict';

// Phase 2.3 — Two-query orchestrator integration tests (8 cases).
//
// Verifies that runSupportAgent correctly routes between:
//   (a) the LEGACY single-prompt path when tenants.features.voice_two_query
//       is falsy / missing OR when handleAction is not injected, and
//   (b) the NEW brain → handleAction → persona orchestrator path when both
//       the flag is on AND handleAction + handleActionContext are injected.
//
// Plus a route-layer parity test (I6) confirming /chat and /voice/:slug/
// booking-assistant both return the identical structured response shape.
//
// I8 (real-Claude latency benchmark) is a separate Node script at
// scripts/benchmark/voice-two-query.js — not part of this Jest suite.

// ── Mocks (must be declared before requires) ────────────────────────────
const mockClaudeCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockClaudeCreate },
  }));
});

jest.mock('../db', () => ({
  query: jest.fn(),
  pool: { query: jest.fn() },
}));

jest.mock('../utils/tenants', () => ({
  getTenantBySlug: jest.fn(),
}));

jest.mock('../utils/voiceContext', () => ({
  buildVoiceSystemPromptOverride: jest.fn(() => 'mock-voice-prompt-override'),
}));

jest.mock('../utils/availabilityEngine', () => ({
  buildAvailabilitySlots: jest.fn(),
  normalizeDateInput: (d) => d,
}));

// ── Module loads (after mocks) ──────────────────────────────────────────
const db = require('../db');
const tenants = require('../utils/tenants');
const aiContextCache = require('../utils/aiContextCache');
const { runSupportAgent } = require('../utils/claudeService');
const aiRoutes = require('../routes/ai');
const voiceRoutes = require('../routes/voice');

global.fetch = jest.fn();

// ── Helpers ─────────────────────────────────────────────────────────────
function claudeJson(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
function claudeText(text) {
  return { content: [{ type: 'text', text }] };
}
function futureISO(daysAhead = 2, hour = 17, minute = 0) {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

const TENANT_KARAOKE_FLAG_OFF = {
  id: 1, name: 'Birdie Golf', timezone: 'Asia/Amman',
  services: [{ id: 16, name: 'Karaoke', duration_minutes: 120, price: 17.5, currency_code: 'JD' }],
};
const TENANT_KARAOKE_FLAG_ON = {
  ...TENANT_KARAOKE_FLAG_OFF,
  features: { voice_two_query: true },
};
const HA_CONTEXT = {
  tenantId: 1, tenantSlug: 'birdie-golf',
  customerId: 99, email: 'x@y.com', authToken: 'token-x',
};

beforeEach(() => {
  mockClaudeCreate.mockReset();
  aiContextCache._resetForTests();
  if (aiRoutes._slotConfirmationCacheForTests?._resetForTests) {
    aiRoutes._slotConfirmationCacheForTests._resetForTests();
  }
  if (db.query.mockReset) db.query.mockReset();
  if (db.pool?.query?.mockReset) db.pool.query.mockReset();
  if (tenants.getTenantBySlug.mockReset) tenants.getTenantBySlug.mockReset();
  if (global.fetch.mockReset) global.fetch.mockReset();
});

// ════════════════════════════════════════════════════════════════════════
// I1 — flag OFF returns legacy { reply, action } shape (no orchestrated marker)
// ════════════════════════════════════════════════════════════════════════
describe('I1 — legacy shape with flag OFF', () => {
  test('returns { reply, action } only — no orchestrated, pendingBooking, or slots fields', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText('Sure, here are your options.'));

    const result = await runSupportAgent({
      tenantContext: TENANT_KARAOKE_FLAG_OFF,
      customerData: null,
      isSignedIn: false,
      history: [],
      message: 'hi',
    });

    expect(result.orchestrated).toBeUndefined();
    expect(result.pendingBooking).toBeUndefined();
    expect(result.slots).toBeUndefined();
    expect(result.reply).toBe('Sure, here are your options.');
    expect(result.action).toBeNull();
    expect(mockClaudeCreate).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// I2 — flag ON, check_availability happy path (brain → handleAction → persona)
// ════════════════════════════════════════════════════════════════════════
describe('I2 — flag ON, check_availability orchestrates the full pipeline', () => {
  test('brain returns action; handleAction injected runs; persona phrases', async () => {
    const tomorrow = new Date(Date.now() + 86400000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Amman' });

    let callIdx = 0;
    mockClaudeCreate.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) {
        return claudeJson({
          intent: 'check_availability',
          action: { type: 'check_availability', service_id: 16, date: tomorrow, resource_id: null, staff_id: null },
          answer: null,
        });
      }
      return claudeText('Sim 1 is open at 5pm, 6pm, and 9pm. Which works?');
    });

    const mockHandleAction = jest.fn().mockResolvedValue({
      success: true,
      structured: true,
      slots: [
        { time: '17:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }] },
        { time: '18:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }] },
        { time: '21:00', any_free: true, resources: [{ id: 1, name: 'Sim 1', free: true }] },
      ],
    });

    const result = await runSupportAgent({
      tenantContext: TENANT_KARAOKE_FLAG_ON,
      customerData: null,
      isSignedIn: false,
      history: [],
      message: "what's available tomorrow",
      handleAction: mockHandleAction,
      handleActionContext: HA_CONTEXT,
    });

    expect(result.orchestrated).toBe(true);
    expect(mockClaudeCreate).toHaveBeenCalledTimes(2);
    expect(mockHandleAction).toHaveBeenCalledTimes(1);
    expect(mockHandleAction.mock.calls[0][0]).toEqual(expect.objectContaining({
      type: 'check_availability', service_id: 16,
    }));
    expect(result.slots).toHaveLength(3);
    expect(result.pendingBooking).toBeNull();
    expect(result.reply).toContain('Sim 1');
  });
});

// ════════════════════════════════════════════════════════════════════════
// I3 — flag ON, create_booking confirmation flow
// ════════════════════════════════════════════════════════════════════════
describe('I3 — flag ON, create_booking confirmation flow', () => {
  test('brain emits create_booking; handleAction executes; persona renders confirmation', async () => {
    const start = futureISO(2, 17, 0);

    let callIdx = 0;
    mockClaudeCreate.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) {
        return claudeJson({
          intent: 'create_booking',
          action: {
            type: 'create_booking', service_id: 16, start_time: start,
            duration_minutes: 120, resource_id: 1, staff_id: null,
            payment_method: 'cash', membership_id: null, prepaid_entitlement_id: null, slots: 2,
          },
          answer: null,
        });
      }
      return claudeText('Booked! Confirmation #123. See you Saturday.');
    });

    const mockHandleAction = jest.fn().mockResolvedValue({
      success: true,
      bookingId: 123,
      message: '✅ Booked!',
    });

    const result = await runSupportAgent({
      tenantContext: TENANT_KARAOKE_FLAG_ON,
      customerData: { profile: { id: 99 }, bookings: [], memberships: [], packages: [] },
      isSignedIn: true,
      history: [
        { role: 'user', content: 'book sim 1 at 5pm cash' },
        { role: 'assistant', content: 'Sim 1 at 5pm cash — confirm?' },
      ],
      message: 'yes',
      confirmationMode: true,
      handleAction: mockHandleAction,
      handleActionContext: HA_CONTEXT,
    });

    expect(result.orchestrated).toBe(true);
    expect(mockClaudeCreate).toHaveBeenCalledTimes(2);
    expect(mockHandleAction).toHaveBeenCalledTimes(1);
    expect(result.action).toEqual(expect.objectContaining({ success: true, bookingId: 123 }));
    expect(result.pendingBooking).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// I4 — flag ON, brain parse_failure → persona recovery; handleAction NOT called
// ════════════════════════════════════════════════════════════════════════
describe('I4 — flag ON, parse_failure recovery path', () => {
  test('brain returns prose without JSON → parse_failure; handleAction skipped; persona renders recovery', async () => {
    let callIdx = 0;
    mockClaudeCreate.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) return claudeText('Sure thing!');
      return claudeText('Sorry, could you rephrase?');
    });

    const mockHandleAction = jest.fn();

    const result = await runSupportAgent({
      tenantContext: TENANT_KARAOKE_FLAG_ON,
      customerData: null,
      isSignedIn: false,
      history: [],
      message: 'hi',
      handleAction: mockHandleAction,
      handleActionContext: HA_CONTEXT,
    });

    expect(result.orchestrated).toBe(true);
    expect(mockClaudeCreate).toHaveBeenCalledTimes(2);
    expect(mockHandleAction).not.toHaveBeenCalled();
    expect(result.action).toBeNull();
    expect(result.pendingBooking).toBeNull();
    expect(result.reply).toMatch(/rephrase/i);
  });
});

// ════════════════════════════════════════════════════════════════════════
// I5 — flag ON, brain confirm_proposal → pendingBooking populated structurally
// ════════════════════════════════════════════════════════════════════════
describe('I5 — flag ON, confirm_proposal populates pendingBooking', () => {
  test('brain emits confirm_proposal; handleAction NOT called; persona computes pendingBooking from payload', async () => {
    const start = futureISO(2, 17, 0);
    const proposalPayload = {
      service_id: 16, start_time: start, duration_minutes: 120,
      resource_id: 1, staff_id: null, payment_method: 'cash',
      membership_id: null, prepaid_entitlement_id: null, slots: 2,
    };

    let callIdx = 0;
    mockClaudeCreate.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) {
        return claudeJson({
          intent: 'clarify',
          action: null,
          answer: { kind: 'confirm_proposal', payload: proposalPayload },
        });
      }
      return claudeText('Sim 1 tomorrow at 5pm for 2 hours, cash — shall I confirm?');
    });

    const mockHandleAction = jest.fn();

    const result = await runSupportAgent({
      tenantContext: TENANT_KARAOKE_FLAG_ON,
      customerData: { profile: { id: 99 }, bookings: [], memberships: [], packages: [] },
      isSignedIn: true,
      history: [],
      message: 'book sim 1 at 5pm tomorrow cash',
      handleAction: mockHandleAction,
      handleActionContext: HA_CONTEXT,
    });

    expect(result.orchestrated).toBe(true);
    expect(mockHandleAction).not.toHaveBeenCalled();
    expect(result.action).toBeNull();
    expect(result.pendingBooking).toEqual({
      service_id: 16, start_time: start, duration_minutes: 120,
      resource_id: 1, staff_id: null, payment_method: 'cash',
      membership_id: null, prepaid_entitlement_id: null, slots: 2,
    });
    expect(result.reply).toMatch(/confirm/i);
  });
});

// ════════════════════════════════════════════════════════════════════════
// I6 — route-layer parity with flag ON (chat and voice produce identical shape)
// ════════════════════════════════════════════════════════════════════════
describe('I6 — route-layer parity with flag ON', () => {
  test('/chat and /voice/:slug/booking-assistant return identical response shape', async () => {
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const request = require('supertest');

    tenants.getTenantBySlug.mockResolvedValue({
      id: 1, slug: 'birdie-golf', name: 'Birdie Golf', timezone: 'Asia/Amman',
      features: { voice_two_query: true },
    });

    db.query.mockResolvedValue({ rows: [] });

    let callIdx = 0;
    mockClaudeCreate.mockImplementation(async () => {
      callIdx++;
      // Odd calls = brain; even calls = persona. With one brain+one persona per route call,
      // sequence across both routes is brain, persona, brain, persona.
      if (callIdx % 2 === 1) {
        return claudeJson({
          intent: 'answer',
          action: null,
          answer: { kind: 'ok', payload: {} },
        });
      }
      return claudeText('Sure, how can I help?');
    });

    const chatApp = express();
    chatApp.use(express.json());
    chatApp.use(cookieParser());
    chatApp.use('/api/ai', aiRoutes);

    const voiceApp = express();
    voiceApp.use(express.json());
    voiceApp.use(cookieParser());
    voiceApp.use('/api/voice', voiceRoutes);

    const chatResp = await request(chatApp)
      .post('/api/ai/birdie-golf/chat')
      .send({ message: 'hi', history: [] });

    const voiceResp = await request(voiceApp)
      .post('/api/voice/birdie-golf/booking-assistant')
      .send({ query: 'hi', history: [] });

    expect(chatResp.status).toBe(200);
    expect(voiceResp.status).toBe(200);

    // Identical response shape
    expect(Object.keys(chatResp.body).sort()).toEqual(['action', 'pendingBooking', 'reply', 'slots']);
    expect(Object.keys(voiceResp.body).sort()).toEqual(['action', 'pendingBooking', 'reply', 'slots']);

    expect(chatResp.body.reply).toBe(voiceResp.body.reply);
    expect(chatResp.body.pendingBooking).toEqual(voiceResp.body.pendingBooking);
    expect(chatResp.body.slots).toEqual(voiceResp.body.slots);
  });
});

// ════════════════════════════════════════════════════════════════════════
// I7 — Phase 2.0 Test 5 (confirmation retry) regression assertion
// ════════════════════════════════════════════════════════════════════════
describe('I7 — Phase 2.0 Test 5 regression (flag OFF, legacy retry preserved)', () => {
  test('confirmationMode=true without features field → 2 Claude calls (initial + retry)', async () => {
    let callIdx = 0;
    mockClaudeCreate.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) {
        return claudeText('Booking confirmed! Talk soon.');
      }
      return claudeText(
        'ACTION:{"type":"create_booking","service_id":16,"start_time":"2026-05-20T17:00:00+03:00","duration_minutes":120,"resource_id":1,"staff_id":null,"payment_method":"cash","membership_id":null,"prepaid_entitlement_id":null,"slots":2}',
      );
    });

    const result = await runSupportAgent({
      tenantContext: TENANT_KARAOKE_FLAG_OFF,  // no features field → legacy path
      customerData: null,
      isSignedIn: false,
      history: [
        { role: 'user', content: 'book sim 1 at 5pm' },
        { role: 'assistant', content: 'Shall I confirm Sim 1 at 5pm cash?' },
      ],
      message: 'yes',
      confirmationMode: true,
    });

    expect(mockClaudeCreate).toHaveBeenCalledTimes(2);
    expect(result.orchestrated).toBeUndefined();
    expect(result.action).toEqual(expect.objectContaining({
      type: 'create_booking', service_id: 16,
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════
// I9 — defensive fallback: flag ON but handleAction not injected → legacy path
// ════════════════════════════════════════════════════════════════════════
describe('I9 — defensive guard: missing handleAction falls back to legacy', () => {
  test('flag ON without injected handleAction → legacy single-prompt path runs', async () => {
    mockClaudeCreate.mockResolvedValue(claudeText('Sure, here are your options.'));

    const result = await runSupportAgent({
      tenantContext: TENANT_KARAOKE_FLAG_ON,  // flag ON
      customerData: null,
      isSignedIn: false,
      history: [],
      message: 'hi',
      // handleAction NOT injected
    });

    // Falls back to legacy — no orchestrated marker, single Claude call
    expect(result.orchestrated).toBeUndefined();
    expect(result.reply).toBe('Sure, here are your options.');
    expect(mockClaudeCreate).toHaveBeenCalledTimes(1);
  });
});
