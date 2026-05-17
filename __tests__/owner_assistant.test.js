'use strict';

// __tests__/owner_assistant.test.js
//
// Covers POST /api/owner/assistant/:tenantSlug/chat.
//
// Cases:
//   1. 401 when no auth
//   2. 403 when role is below owner (e.g. staff)
//   3. 400 when message missing
//   4. 404 when tenant slug not found
//   5. 200 happy path with mocked Anthropic
//
// Approach: middleware behavior is controlled per-test via the
// `authState` mutable object that the mocks read from. Anthropic SDK
// and dashboardSummary are mocked at the module boundary.

const express = require("express");
const request = require("supertest");

// ── Mutable auth state read by middleware mocks ──────────────────────────
const authState = {
  authed: true,          // requireAppAuth result
  userId: 1,             // ensureUser result
  tenantRole: "owner",   // requireTenantRole result
};

function resetAuthState() {
  authState.authed = true;
  authState.userId = 1;
  authState.tenantRole = "owner";
}

// ── Mocks (must be before requires) ──────────────────────────────────────
jest.mock("../db", () => ({
  query: jest.fn(),
  pool: { query: jest.fn(), on: jest.fn() },
  connect: jest.fn(),
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));

// Anthropic SDK — capture create call and return controllable response.
const mockClaudeCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockClaudeCreate },
  }));
});

// Tenant lookup is the gate for the 404 case.
const mockGetTenantBySlug = jest.fn();
jest.mock("../utils/tenants", () => ({
  getTenantBySlug: (...args) => mockGetTenantBySlug(...args),
  // requireTenant uses getTenantIdFromSlug — provide a passthrough that
  // resolves any slug to 1 so the auth chain advances; the route handler
  // then calls getTenantBySlug itself for the real tenant lookup / 404.
  getTenantIdFromSlug: jest.fn(async () => 1),
}));

// dashboardSummary — return a small canned snapshot so the system prompt
// builder has something to embed.
const mockGetDashboardSummary = jest.fn();
jest.mock("../utils/dashboardSummary", () => ({
  getDashboardSummary: (...args) => mockGetDashboardSummary(...args),
}));

// Auth middleware mocks. requireAdminOrTenantRole wraps requireAppAuth +
// ensureUser + requireTenantRole; mock the wrapper directly and key its
// behavior off authState so individual tests can flip 401/403.
jest.mock("../middleware/requireAdminOrTenantRole", () => () => {
  return function (req, res, next) {
    if (!authState.authed) return res.status(401).json({ error: "Unauthenticated." });
    if (!authState.tenantRole) return res.status(403).json({ error: "No access to this tenant." });
    // Simple role check: only owners pass for our route.
    const RANK = { viewer: 1, staff: 2, manager: 3, owner: 4 };
    if ((RANK[authState.tenantRole] || 0) < RANK.owner) {
      return res.status(403).json({ error: "Forbidden." });
    }
    req.user = { id: authState.userId, email: "owner@test.com" };
    req.tenantRole = authState.tenantRole;
    return next();
  };
});

// ── App + module loads (after mocks) ─────────────────────────────────────
function makeApp() {
  const app = express();
  app.use(express.json());
  const router = require("../routes/owner/assistant");
  app.use("/api/owner/assistant", router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuthState();
  mockGetTenantBySlug.mockResolvedValue({
    id: 1,
    slug: "birdie-golf",
    name: "Birdie Golf",
    timezone: "Asia/Amman",
  });
  mockGetDashboardSummary.mockResolvedValue({
    range: { from: "2026-05-17T00:00:00.000Z", to: "2026-05-18T00:00:00.000Z" },
    currency_code: "JD",
    kpis: {
      bookings: 3, pending: 1, cancelled: 0,
      revenue_amount: 145, utilizationPct: 42, repeatPct: 67,
      activeMemberships: 12, noShowRate: 0,
    },
    utilization: { overall: { booked_minutes: 240, available_minutes: 600 } },
    panels: {
      nextBookings: [
        { start_time: "2026-05-17T17:00:00+03:00", service_name: "Sim Bay", customer_name: "Alice", status: "confirmed" },
      ],
      alerts: [],
      insights: [],
    },
  });
  mockClaudeCreate.mockResolvedValue({
    content: [{ type: "text", text: "You have 3 confirmed bookings today." }],
  });
});

// ════════════════════════════════════════════════════════════════════════
// 1. 401 — no auth
// ════════════════════════════════════════════════════════════════════════
describe("POST /api/owner/assistant/:tenantSlug/chat — 401", () => {
  test("returns 401 when unauthenticated", async () => {
    authState.authed = false;
    const res = await request(makeApp())
      .post("/api/owner/assistant/birdie-golf/chat")
      .send({ message: "today's bookings" });
    expect(res.status).toBe(401);
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. 403 — wrong role (staff trying to use owner-only endpoint)
// ════════════════════════════════════════════════════════════════════════
describe("POST /api/owner/assistant/:tenantSlug/chat — 403", () => {
  test("returns 403 when role is staff (below owner)", async () => {
    authState.tenantRole = "staff";
    const res = await request(makeApp())
      .post("/api/owner/assistant/birdie-golf/chat")
      .send({ message: "today's bookings" });
    expect(res.status).toBe(403);
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. 400 — message missing
// ════════════════════════════════════════════════════════════════════════
describe("POST /api/owner/assistant/:tenantSlug/chat — 400", () => {
  test("returns 400 when body has no message", async () => {
    const res = await request(makeApp())
      .post("/api/owner/assistant/birdie-golf/chat")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });

  test("returns 400 when message is empty string", async () => {
    const res = await request(makeApp())
      .post("/api/owner/assistant/birdie-golf/chat")
      .send({ message: "   " });
    expect(res.status).toBe(400);
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. 404 — tenant not found
// ════════════════════════════════════════════════════════════════════════
describe("POST /api/owner/assistant/:tenantSlug/chat — 404", () => {
  test("returns 404 when getTenantBySlug throws TENANT_NOT_FOUND", async () => {
    const err = new Error("Tenant not found");
    err.code = "TENANT_NOT_FOUND";
    mockGetTenantBySlug.mockRejectedValueOnce(err);

    const res = await request(makeApp())
      .post("/api/owner/assistant/ghost-tenant/chat")
      .send({ message: "today's bookings" });
    expect(res.status).toBe(404);
    expect(mockClaudeCreate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. 200 — happy path
// ════════════════════════════════════════════════════════════════════════
describe("POST /api/owner/assistant/:tenantSlug/chat — 200 happy path", () => {
  test("returns reply and calls Anthropic with correct shape", async () => {
    const res = await request(makeApp())
      .post("/api/owner/assistant/birdie-golf/chat")
      .send({
        message: "How many bookings today?",
        history: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hi! What would you like to know?" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/3 confirmed bookings/i);
    expect(res.body.actionTaken).toBeNull();

    expect(mockClaudeCreate).toHaveBeenCalledTimes(1);
    const call = mockClaudeCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.max_tokens).toBe(600);
    expect(call.temperature).toBe(0.3);
    expect(typeof call.system).toBe("string");
    // System prompt should embed the tenant name and the KPI snapshot.
    expect(call.system).toMatch(/Birdie Golf/);
    expect(call.system).toMatch(/Bookings confirmed:\s*3/);
    // History should be passed through plus the new user message.
    expect(call.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hi! What would you like to know?" },
      { role: "user", content: "How many bookings today?" },
    ]);
  });

  test("survives dashboardSummary failure with empty snapshot fallback", async () => {
    mockGetDashboardSummary.mockRejectedValueOnce(new Error("DB timeout"));

    const res = await request(makeApp())
      .post("/api/owner/assistant/birdie-golf/chat")
      .send({ message: "What's utilization?" });

    expect(res.status).toBe(200);
    expect(mockClaudeCreate).toHaveBeenCalledTimes(1);
    // System prompt still rendered with safe defaults.
    const call = mockClaudeCreate.mock.calls[0][0];
    expect(call.system).toMatch(/Birdie Golf/);
  });
});
