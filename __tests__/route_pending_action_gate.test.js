'use strict';

// Routes-level direct-execute gate tests (2026-05-26).
//
// Locks in the two-factor gate at the pre-runSupportAgent direct-execute
// branch on both /api/ai/:slug/chat and /api/voice/:slug/booking-assistant.
// Prior to this fix, the branch executed handleAction on pendingAction
// ALONE (without confirmationMode). With the fix, it requires both.
//
// Discriminator: mockClaudeCreate.
//   - direct-execute fires → returns early before runSupportAgent → Claude NOT called
//   - direct-execute skipped → runSupportAgent runs → Claude IS called
//
// We don't need to mock handleAction's downstream (db / fetch / etc.) —
// if direct-execute fires, handleAction may fail, but THE GATE DECISION is
// observable via Claude call-count independent of that failure.

// ── Mocks (must precede requires) ─────────────────────────────────────────
jest.mock('../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
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

// ── Module loads (after mocks) ────────────────────────────────────────────
const express = require('express');
const request = require('supertest');
const db = require('../db');
const tenants = require('../utils/tenants');
const aiContextCache = require('../utils/aiContextCache');
const aiRoutes = require('../routes/ai');
const voiceRoutes = require('../routes/voice');

global.fetch = jest.fn().mockResolvedValue({
  ok: false,
  status: 500,
  json: async () => ({ error: 'mocked' }),
  text: async () => 'mocked',
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRoutes);
  app.use('/api/voice', voiceRoutes);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

const PENDING_CB = {
  type: 'create_booking',
  service_id: 1,
  start_time: '2026-05-28T17:00:00Z',
  duration_minutes: 60,
  payment_method: 'cash',
};

const PROPOSAL_HISTORY = [
  { role: 'user', content: 'book sim 3 8pm cash' },
  { role: 'assistant', content: 'Sim 3 at 8:00 PM, cash, 60 min. Shall I confirm?' },
];

beforeEach(() => {
  mockClaudeCreate.mockReset();
  // Default — if Claude IS called, return a benign response so the test
  // doesn't crash on follow-up parsing.
  mockClaudeCreate.mockResolvedValue({ content: [{ type: 'text', text: 'OK' }] });
  if (aiContextCache._resetForTests) aiContextCache._resetForTests();
  tenants.getTenantBySlug.mockReset();
  tenants.getTenantBySlug.mockResolvedValue({
    id: 3,
    slug: 'birdie-golf',
    name: 'Birdie Golf',
    timezone: 'Asia/Amman',
    features: {},
  });
  global.fetch.mockClear();
});

// ════════════════════════════════════════════════════════════════════════════
// /api/ai/:slug/chat — direct-execute gate
// ════════════════════════════════════════════════════════════════════════════
describe('routes/ai direct-execute gate (text chat)', () => {
  test('pendingAction WITHOUT confirmation → direct-execute SKIPPED (Claude IS called)', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/ai/birdie-golf/chat')
      .send({
        message: 'what is the weather',
        history: [],
        pendingAction: PENDING_CB,
      });
    // No prior proposal in history AND message doesn't match isConfirmationMessage
    // → confirmationMode=false → direct-execute gate fails → falls through
    // → runSupportAgent fires Claude.
    expect(mockClaudeCreate).toHaveBeenCalled();
  });

  test('pendingAction WITH confirmation → direct-execute FIRED (Claude NOT called)', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/ai/birdie-golf/chat')
      .send({
        message: 'yes confirm',
        history: PROPOSAL_HISTORY,
        pendingAction: PENDING_CB,
      });
    // "yes confirm" + prior proposal turn ending in ? → confirmationMode=true
    // → direct-execute fires → returns early → Claude NOT called.
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });

  test('pendingAction with confirm message BUT no prior proposal → direct-execute SKIPPED', async () => {
    // isConfirmationMessage('yes') is true, but hasRecentPendingBooking(empty) is false
    // → isConfirmation=false → gate fails → Claude IS called.
    const app = makeApp();
    await request(app)
      .post('/api/ai/birdie-golf/chat')
      .send({
        message: 'yes',
        history: [],
        pendingAction: PENDING_CB,
      });
    expect(mockClaudeCreate).toHaveBeenCalled();
  });

  test('NO pendingAction (regardless of confirmation) → direct-execute SKIPPED', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/ai/birdie-golf/chat')
      .send({
        message: 'yes confirm',
        history: PROPOSAL_HISTORY,
        // pendingAction omitted
      });
    expect(mockClaudeCreate).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /api/voice/:slug/booking-assistant — direct-execute gate
// ════════════════════════════════════════════════════════════════════════════
describe('routes/voice direct-execute gate (voice assistant)', () => {
  test('pendingAction + isConfirming=false → direct-execute SKIPPED (Claude IS called)', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/voice/birdie-golf/booking-assistant')
      .send({
        query: 'what is the weather',
        history: [],
        pendingAction: PENDING_CB,
        isConfirming: false,
      });
    expect(mockClaudeCreate).toHaveBeenCalled();
  });

  test('pendingAction + isConfirming=true → direct-execute FIRED (Claude NOT called)', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/voice/birdie-golf/booking-assistant')
      .send({
        query: 'yes',
        history: PROPOSAL_HISTORY,
        pendingAction: PENDING_CB,
        isConfirming: true,
      });
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });

  test('pendingAction, no isConfirming flag, but prose heuristic passes → direct-execute FIRED', async () => {
    // Voice fallback path: when isConfirming is absent, the route falls back
    // to the text-side heuristic (isConfirmationMessage + hasRecentPendingBooking).
    const app = makeApp();
    await request(app)
      .post('/api/voice/birdie-golf/booking-assistant')
      .send({
        query: 'yes confirm',
        history: PROPOSAL_HISTORY,
        pendingAction: PENDING_CB,
        // isConfirming omitted
      });
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });

  test('pendingAction + isConfirming=true + AR confirm-keyword heuristic also fires', async () => {
    // Even though isConfirming=true wins on its own, this ensures the AR
    // recovery path doesn't get blocked by the heuristic.
    const app = makeApp();
    await request(app)
      .post('/api/voice/birdie-golf/booking-assistant')
      .send({
        query: 'نعم',
        history: [
          { role: 'assistant', content: 'هل أؤكد الحجز؟' },
        ],
        pendingAction: PENDING_CB,
        isConfirming: true,
      });
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });
});
