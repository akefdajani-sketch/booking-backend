'use strict';

// Phase 2.0 — voice agent test net.
//
// Locks in CURRENT behavior of handleAction + runSupportAgent + the
// /api/ai/:slug/chat and /api/voice/:slug/booking-assistant routes,
// so the brain/persona split landing in Phase 2.1/2.2 cannot silently
// regress the 4 known production bugs:
//   A — availability overflow (agent invents slots from prompt context)
//   B — double-booking (concurrent confirmations race)
//   C — fabricated slots (agent proposes a time not in check_availability)
//   D — no personalization (agent ignores customer's past resource choice)
//
// These tests assert current behavior, not aspirational behavior. All
// seven must stay green through Phase 2.4.

// ── Mocks (declared before requires) ────────────────────────────────────
jest.mock('../db', () => ({
  query: jest.fn(),
  pool: { query: jest.fn() },
}));

jest.mock('../utils/availabilityEngine', () => ({
  buildAvailabilitySlots: jest.fn(),
  normalizeDateInput: (d) => d,
}));

const mockClaudeCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockClaudeCreate },
  }));
});

jest.mock('../utils/tenants', () => ({
  getTenantBySlug: jest.fn(),
}));

jest.mock('../utils/voiceContext', () => ({
  buildVoiceSystemPromptOverride: jest.fn(() => 'mock-voice-prompt-override'),
}));

// ── Module loads (after mocks) ──────────────────────────────────────────
const db = require('../db');
const availabilityEngine = require('../utils/availabilityEngine');
const aiContextCache = require('../utils/aiContextCache');
const tenants = require('../utils/tenants');
const aiRoutes = require('../routes/ai');
const voiceRoutes = require('../routes/voice');
const { runSupportAgent } = require('../utils/claudeService');

const handleAction = aiRoutes.handleAction;
const slotCache = aiRoutes._slotConfirmationCacheForTests;

// global.fetch is used by handleAction.create_booking for the /api/bookings POST.
global.fetch = jest.fn();

// ── Helpers ─────────────────────────────────────────────────────────────
function mockDbQuery(routes) {
  // routes: Array<{ match: RegExp|string, rows: any[] | (params)=>any[] }>
  db.query.mockImplementation((sql, params) => {
    for (const r of routes) {
      const matched = typeof r.match === 'string' ? sql.includes(r.match) : r.match.test(sql);
      if (matched) {
        const rows = typeof r.rows === 'function' ? r.rows(params) : r.rows;
        return Promise.resolve({ rows });
      }
    }
    return Promise.resolve({ rows: [] });
  });
}

function mockPoolQuery(routes) {
  db.pool.query.mockImplementation((sql, params) => {
    for (const r of routes) {
      const matched = typeof r.match === 'string' ? sql.includes(r.match) : r.match.test(sql);
      if (matched) {
        const rows = typeof r.rows === 'function' ? r.rows(params) : r.rows;
        return Promise.resolve({ rows });
      }
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  slotCache._resetForTests();
  aiContextCache._resetForTests();
  // Default Claude response; per-test impls override.
  mockClaudeCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'default reply' }],
  });
});

// ════════════════════════════════════════════════════════════════════════
// Test 1 — check_availability happy path (Bug A scaffolding)
// ════════════════════════════════════════════════════════════════════════
describe('handleAction.check_availability', () => {
  test('returns structured per-resource slots and writes the slot cache', async () => {
    mockDbQuery([
      { match: 'FROM services WHERE id', rows: [{
        id: 16, name: 'Karaoke', duration_minutes: 120,
        max_parallel_bookings: 1, slot_interval_minutes: 60,
        requires_staff: false,
      }] },
      { match: 'SELECT timezone FROM tenants', rows: [{ timezone: 'Asia/Amman' }] },
      { match: 'resource_service_links', rows: [
        { id: 1, name: 'Sim 1' },
        { id: 2, name: 'Sim 2' },
      ] },
    ]);

    availabilityEngine.buildAvailabilitySlots.mockResolvedValue({
      slots: [
        { time: '17:00', is_available: true },
        { time: '18:00', is_available: true },
      ],
      meta: { reason: 'ok' },
    });

    const result = await handleAction(
      { type: 'check_availability', service_id: 16, date: '2026-05-20' },
      1, 'birdie-golf', 99, 'cust@example.com', 'token-x',
    );

    expect(result.success).toBe(true);
    expect(result.structured).toBe(true);
    expect(result.slots).toHaveLength(2);
    expect(result.slots[0]).toEqual(expect.objectContaining({
      time: '17:00', any_free: true,
    }));
    const resourceIds = result.slots[0].resources.map((r) => r.id).sort();
    expect(resourceIds).toEqual([1, 2]);
    expect(result.slots[0].resources.every((r) => r.free === true)).toBe(true);

    // 2 resources × 1 (null staff) = 2 engine calls
    expect(availabilityEngine.buildAvailabilitySlots).toHaveBeenCalledTimes(2);

    // Slot cache populated for (tenant=1, customer=99, service=16, date=2026-05-20)
    const cached = slotCache.get(1, 99, 16, '2026-05-20');
    expect(cached).not.toBeNull();
    expect(cached.slots.map((s) => s.time).sort()).toEqual(['17:00', '18:00']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Test 2 — create_booking rejects fabricated slot (Bug C)
// ════════════════════════════════════════════════════════════════════════
describe('handleAction.create_booking — Bug C (fabricated slots)', () => {
  test('rejects start_time not in slot cache and never POSTs to /api/bookings', async () => {
    slotCache.set(1, 99, 16, '2026-05-20', [
      { time: '17:00', resource_id: 1 },
      { time: '18:00', resource_id: 1 },
    ]);

    mockDbQuery([
      { match: 'FROM services WHERE id', rows: [{
        id: 16, name: 'Karaoke', duration_minutes: 120,
        max_parallel_bookings: 1, slot_interval_minutes: 60,
      }] },
      { match: 'SELECT timezone FROM tenants', rows: [{ timezone: 'Asia/Amman' }] },
    ]);

    const result = await handleAction(
      {
        type: 'create_booking',
        service_id: 16,
        start_time: '2026-05-20T19:30:00+03:00',
        resource_id: 1,
        duration_minutes: 120,
      },
      1, 'birdie-golf', 99, 'cust@example.com', 'token-x',
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/19:30/);
    expect(result.message).toMatch(/17:00/);
    expect(result.message).toMatch(/18:00/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Test 3 — create_booking rejects concurrent conflict (Bug B)
// ════════════════════════════════════════════════════════════════════════
describe('handleAction.create_booking — Bug B (concurrent conflict)', () => {
  test('rejects when conflicting booking found and busts the slot cache', async () => {
    slotCache.set(1, 99, 16, '2026-05-20', [
      { time: '17:00', resource_id: 5 },
    ]);
    expect(slotCache.get(1, 99, 16, '2026-05-20')).not.toBeNull();

    mockDbQuery([
      { match: 'FROM services WHERE id', rows: [{
        id: 16, name: 'Karaoke', duration_minutes: 120,
        max_parallel_bookings: 1, slot_interval_minutes: 60,
      }] },
      { match: 'SELECT timezone FROM tenants', rows: [{ timezone: 'Asia/Amman' }] },
    ]);
    mockPoolQuery([
      // hasConflictingBooking — overlap predicate returns 1 conflicting row
      { match: 'booking_range && tstzrange', rows: [{ n: 1 }] },
    ]);

    const result = await handleAction(
      {
        type: 'create_booking',
        service_id: 16,
        start_time: '2026-05-20T17:00:00+03:00',
        resource_id: 5,
        duration_minutes: 120,
      },
      1, 'birdie-golf', 99, 'cust@example.com', 'token-x',
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/just taken|let me check what else/i);
    expect(global.fetch).not.toHaveBeenCalled();
    // bustForBooking removes all (tenant, service, date) entries
    expect(slotCache.get(1, 99, 16, '2026-05-20')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Test 4 — buildCustomerContext USABLE NOW filter (Bug D foundation)
// ════════════════════════════════════════════════════════════════════════
describe('buildCustomerContext USABLE NOW filter — Bug D foundation', () => {
  test('USABLE NOW excludes expired memberships and zero-balance packages; history blocks preserve all', async () => {
    let capturedSystemText = null;
    mockClaudeCreate.mockImplementation(async (req) => {
      capturedSystemText = req.system?.[0]?.text || null;
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const now = Date.now();
    const customerData = {
      profile: {
        id: 99, name: 'Test User', email: 'test@example.com',
        phone: '+1', created_at: new Date(now - 1000 * 86400 * 30).toISOString(),
      },
      bookings: [],
      memberships: [
        // Expired — end_at in the past
        { id: 1, status: 'active', plan_name: 'Gold',
          end_at: new Date(now - 1000 * 86400).toISOString(),
          minutes_remaining: 100, uses_remaining: null },
        // Active — should appear in USABLE NOW
        { id: 2, status: 'active', plan_name: 'Silver',
          end_at: new Date(now + 1000 * 86400 * 30).toISOString(),
          minutes_remaining: 60, uses_remaining: null },
      ],
      packages: [
        // Zero balance
        { id: 10, status: 'active', product_name: 'Lessons',
          remaining_quantity: 0, original_quantity: 5,
          expires_at: null, eligible_service_ids: null },
        // Active, restricted to service_id 5
        { id: 11, status: 'active', product_name: 'Sim Pack',
          remaining_quantity: 4, original_quantity: 5,
          expires_at: null, eligible_service_ids: [5] },
      ],
    };

    await runSupportAgent({
      tenantContext: {
        id: 1, name: 'Birdie Golf', timezone: 'Asia/Amman',
        services: [{ id: 5, name: 'Group Lesson' }],
      },
      customerData,
      isSignedIn: true,
      history: [],
      message: 'hi',
    });

    expect(capturedSystemText).toBeTruthy();

    // Locate the USABLE NOW section (ends at the next blank line or prompt end)
    const idx = capturedSystemText.indexOf('USABLE NOW');
    expect(idx).toBeGreaterThan(-1);
    const rest = capturedSystemText.slice(idx);
    const endIdx = rest.indexOf('\n\n');
    const usableNowSection = endIdx > -1 ? rest.slice(0, endIdx) : rest;

    // Active items appear in USABLE NOW
    expect(usableNowSection).toContain('membership id:2');
    expect(usableNowSection).toContain('package id:11');
    // Restricted package surfaces its service_id constraint
    expect(usableNowSection).toContain('ONLY for service_id 5');

    // Expired membership and zero-balance package are absent from USABLE NOW
    expect(usableNowSection).not.toContain('membership id:1');
    expect(usableNowSection).not.toContain('package id:10');

    // History is preserved elsewhere in the prompt (ACTIVE MEMBERSHIPS /
    // PREPAID PACKAGES blocks above USABLE NOW list everything)
    expect(capturedSystemText).toContain('membership id:1');
    expect(capturedSystemText).toContain('package id:10');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Test 5 — runSupportAgent confirmationMode retry (Bug B/C orchestration)
// ════════════════════════════════════════════════════════════════════════
describe('runSupportAgent confirmationMode retry', () => {
  test('issues a one-shot correction when first reply omits ACTION and parses the retry', async () => {
    let callIdx = 0;
    mockClaudeCreate.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) {
        return { content: [{ type: 'text', text: 'Booking confirmed! Talk soon.' }] };
      }
      return { content: [{ type: 'text', text:
        'ACTION:{"type":"create_booking","service_id":16,"start_time":"2026-05-20T17:00:00+03:00","duration_minutes":120,"resource_id":1,"staff_id":null,"payment_method":"cash","membership_id":null,"prepaid_entitlement_id":null,"slots":2}' }] };
    });

    const result = await runSupportAgent({
      tenantContext: { id: 1, name: 'Birdie Golf', timezone: 'Asia/Amman' },
      customerData: null,
      isSignedIn: false,
      history: [
        { role: 'user', content: 'book sim 1 at 5pm tonight' },
        { role: 'assistant', content: 'Shall I confirm Sim 1 at 5pm cash?' },
      ],
      message: 'yes',
      confirmationMode: true,
    });

    expect(mockClaudeCreate).toHaveBeenCalledTimes(2);
    expect(result.action).toEqual(expect.objectContaining({
      type: 'create_booking',
      service_id: 16,
      payment_method: 'cash',
    }));

    // Retry's last user message carries the [CORRECTION: ...] nudge
    const retryCall = mockClaudeCreate.mock.calls[1][0];
    const lastMsg = retryCall.messages[retryCall.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toMatch(/CORRECTION/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Test 6 — multi-resource × multi-staff fan-out + cap (Bug A scaffolding)
// ════════════════════════════════════════════════════════════════════════
describe('handleAction.check_availability fan-out + cap', () => {
  test('5 resources × 3 staff → 15 engine calls, no capHit', async () => {
    mockDbQuery([
      { match: 'FROM services WHERE id', rows: [{
        id: 16, name: 'Karaoke', duration_minutes: 120,
        max_parallel_bookings: 1, slot_interval_minutes: 60,
        requires_staff: true,
      }] },
      { match: 'SELECT timezone FROM tenants', rows: [{ timezone: 'Asia/Amman' }] },
      { match: 'resource_service_links', rows: [
        { id: 1, name: 'Sim 1' }, { id: 2, name: 'Sim 2' }, { id: 3, name: 'Sim 3' },
        { id: 4, name: 'Sim 4' }, { id: 5, name: 'Sim 5' },
      ] },
      { match: 'staff_service_links', rows: [
        { id: 100, name: 'Alice' }, { id: 101, name: 'Bob' }, { id: 102, name: 'Carol' },
      ] },
    ]);
    availabilityEngine.buildAvailabilitySlots.mockResolvedValue({
      slots: [{ time: '17:00', is_available: true }],
      meta: { reason: 'ok' },
    });

    const result = await handleAction(
      { type: 'check_availability', service_id: 16, date: '2026-05-20' },
      1, 'birdie-golf', 99, 'cust@example.com', 'token-x',
    );

    expect(result.success).toBe(true);
    expect(result.capHit).toBeFalsy();
    expect(availabilityEngine.buildAvailabilitySlots).toHaveBeenCalledTimes(15);
  });

  test('7 resources × 6 staff (42 tuples) → capHit=true, exactly 36 engine calls', async () => {
    mockDbQuery([
      { match: 'FROM services WHERE id', rows: [{
        id: 16, name: 'Karaoke', duration_minutes: 120,
        max_parallel_bookings: 1, slot_interval_minutes: 60,
        requires_staff: true,
      }] },
      { match: 'SELECT timezone FROM tenants', rows: [{ timezone: 'Asia/Amman' }] },
      { match: 'resource_service_links', rows:
        Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `R${i + 1}` })) },
      { match: 'staff_service_links', rows:
        Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, name: `S${i}` })) },
    ]);
    availabilityEngine.buildAvailabilitySlots.mockResolvedValue({
      slots: [{ time: '17:00', is_available: true }],
      meta: { reason: 'ok' },
    });

    const result = await handleAction(
      { type: 'check_availability', service_id: 16, date: '2026-05-20' },
      1, 'birdie-golf', 99, 'cust@example.com', 'token-x',
    );

    expect(result.success).toBe(true);
    expect(result.capHit).toBe(true);
    expect(availabilityEngine.buildAvailabilitySlots).toHaveBeenCalledTimes(36);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Test 7 — voice/chat parity (prevents silent drift post-2.1+2.2)
// ════════════════════════════════════════════════════════════════════════
describe('voice/chat parity', () => {
  test('/chat and /voice/:slug/booking-assistant return identical response shape and content', async () => {
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const request = require('supertest');

    tenants.getTenantBySlug.mockResolvedValue({
      id: 1, slug: 'birdie-golf', name: 'Birdie Golf', timezone: 'Asia/Amman',
    });

    // fetchBusinessContext fires many parallel queries — return empty rows for all.
    db.query.mockResolvedValue({ rows: [] });

    // Claude reply with no ACTION line, so neither path branches into handleAction.
    mockClaudeCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Sure, how can I help?' }],
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

    // Identical response shape: reply, action, pendingBooking, slots
    expect(Object.keys(chatResp.body).sort())
      .toEqual(['action', 'pendingBooking', 'reply', 'slots']);
    expect(Object.keys(voiceResp.body).sort())
      .toEqual(['action', 'pendingBooking', 'reply', 'slots']);

    expect(chatResp.body.reply).toBe(voiceResp.body.reply);
    expect(chatResp.body.action).toEqual(voiceResp.body.action);
    expect(chatResp.body.pendingBooking).toEqual(voiceResp.body.pendingBooking);
    expect(chatResp.body.slots).toEqual(voiceResp.body.slots);
  });
});
