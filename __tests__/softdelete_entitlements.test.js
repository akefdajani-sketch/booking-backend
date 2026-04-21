// __tests__/softdelete_entitlements.test.js
// PR-10: Tests for soft-delete (customers) and entitlement enforcement

"use strict";

const request = require("supertest");

// ── Mock DB ───────────────────────────────────────────────────────────────────
// IMPORTANT: db.query and db.pool.query must be the SAME function so that
// both `const db = require('../db'); db.query(...)` and
// `const { pool } = require('../db'); pool.query(...)` callers are intercepted.
const mockQuery = jest.fn();
jest.mock("../db", () => ({
  pool: { query: mockQuery, on: jest.fn() },
  query: mockQuery,
  connect: jest.fn(),
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: jest.fn(() => ({ info: jest.fn(), error: jest.fn() })),
}));
jest.mock("../utils/sentry", () => ({
  initSentry: jest.fn(), captureException: jest.fn(),
  Sentry: { withScope: jest.fn() },
}));

// ── Mock auth middleware (bypass for tests) ───────────────────────────────────
jest.mock("../middleware/requireAdmin", () =>
  (req, res, next) => next()
);
jest.mock("../middleware/requireAdminOrTenantRole", () =>
  () => (req, res, next) => next()
);
jest.mock("../middleware/requireGoogleAuth", () =>
  (req, res, next) => next()
);
jest.mock("../middleware/requireTenant", () => ({
  requireTenant: (req, res, next) => {
    req.tenantId = 99;
    req.tenantSlug = "test-tenant";
    next();
  },
}));

const express = require("express");
const customersRouter = require("../routes/customers");
const { hasFeature, requireFeature } = require("../utils/entitlements");

const app = express();
app.use(express.json());
app.use("/api/customers", customersRouter);

beforeEach(() => {
  mockQuery.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// SOFT DELETE — customers
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/customers/:customerId — soft delete", () => {
  test("soft-deletes an existing customer", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42 }] });

    const res = await request(app)
      .delete("/api/customers/42")
      .set("x-admin-key", "test");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(true);

    const call = mockQuery.mock.calls[0];
    expect(call[0]).toMatch(/SET deleted_at = NOW\(\)/);
    expect(call[0]).toMatch(/deleted_at IS NULL/);
    expect(call[1]).toEqual([42, 99]);
  });

  test("returns 404 if customer not found or already deleted", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app)
      .delete("/api/customers/999")
      .set("x-admin-key", "test");

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  test("returns 400 for invalid customerId", async () => {
    const res = await request(app)
      .delete("/api/customers/abc")
      .set("x-admin-key", "test");

    expect(res.status).toBe(400);
  });

  test("does NOT perform a hard DELETE query", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5 }] });

    await request(app)
      .delete("/api/customers/5")
      .set("x-admin-key", "test");

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).not.toMatch(/DELETE FROM customers/);
    expect(sql).toMatch(/UPDATE customers/);
  });
});

describe("PATCH /api/customers/:customerId/restore", () => {
  test("restores a soft-deleted customer", async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 42, name: "Alice", email: "alice@example.com" }],
    });

    const res = await request(app)
      .patch("/api/customers/42/restore")
      .set("x-admin-key", "test");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.customer).toMatchObject({ id: 42 });

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toMatch(/SET deleted_at = NULL/);
    expect(sql).toMatch(/deleted_at IS NOT NULL/);
  });

  test("returns 404 if customer is not deleted", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app)
      .patch("/api/customers/42/restore")
      .set("x-admin-key", "test");

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTITLEMENTS — hasFeature + requireFeature
// ─────────────────────────────────────────────────────────────────────────────

describe("hasFeature()", () => {
  // D4 FINISH adds a third query path: when neither the trial check nor the
  // tenant_entitlements cache returns a row, hasFeature() falls through to
  // saas_plans → saas_plan_features. Tests below mock all 3 query layers.

  test("returns true if tenant is on trialing subscription", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: "trialing" }] });
    const result = await hasFeature(1, "memberships");
    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("returns true if entitlement feature_value is 'true'", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no trial
    mockQuery.mockResolvedValueOnce({ rows: [{ feature_value: "true" }] });
    const result = await hasFeature(2, "memberships");
    expect(result).toBe(true);
  });

  test("returns false if entitlement feature_value is 'false'", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ feature_value: "false" }] });
    const result = await hasFeature(2, "memberships");
    expect(result).toBe(false);
  });

  test("returns false if no entitlement row exists AND no plan-feature match", async () => {
    // No trial, no cache, no saas_plans fallback match → false
    mockQuery.mockResolvedValueOnce({ rows: [] });  // trial check
    mockQuery.mockResolvedValueOnce({ rows: [] });  // entitlements cache
    mockQuery.mockResolvedValueOnce({ rows: [] });  // D4.6 saas_plans fallback
    const result = await hasFeature(3, "calendar_planning");
    expect(result).toBe(false);
  });

  test("returns true via D4.6 fallback when plan-feature is enabled", async () => {
    // Tenant has a subscription to a plan that enables the feature via
    // saas_plan_features, but the tenant_entitlements cache hasn't been
    // populated yet (grandfathered tenants, pre-webhook-run tenants).
    mockQuery.mockResolvedValueOnce({ rows: [] });  // trial check
    mockQuery.mockResolvedValueOnce({ rows: [] });  // entitlements cache
    mockQuery.mockResolvedValueOnce({ rows: [{ enabled: true }] });  // fallback
    const result = await hasFeature(3, "memberships");
    expect(result).toBe(true);
  });

  test("returns false via D4.6 fallback when plan-feature is disabled", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ enabled: false }] });
    const result = await hasFeature(3, "api_access");
    expect(result).toBe(false);
  });

  test("returns true for numeric feature_value '1'", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ feature_value: "1" }] });
    const result = await hasFeature(4, "api_access");
    expect(result).toBe(true);
  });

  test("returns false for numeric feature_value '0'", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ feature_value: "0" }] });
    const result = await hasFeature(4, "api_access");
    expect(result).toBe(false);
  });
});

describe("requireFeature() middleware", () => {
  test("calls next() when tenant has the feature", async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, res, next) => { req.tenantId = 10; next(); });
    testApp.get("/test", requireFeature("memberships"), (req, res) => res.json({ ok: true }));

    mockQuery.mockResolvedValueOnce({ rows: [{ status: "trialing" }] });
    const res = await request(testApp).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("returns 403 when tenant lacks the feature", async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, res, next) => { req.tenantId = 20; next(); });
    testApp.get("/test", requireFeature("multi_location"), (req, res) => res.json({ ok: true }));

    mockQuery.mockResolvedValueOnce({ rows: [] }); // no trial
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no entitlement cache
    mockQuery.mockResolvedValueOnce({ rows: [] }); // D4.6 fallback: no plan-feature match

    const res = await request(testApp).get("/test");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FEATURE_NOT_AVAILABLE");
    expect(res.body.feature).toBe("multi_location");
  });

  test("returns 401 if tenantId is not set", async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.get("/test", requireFeature("memberships"), (req, res) => res.json({ ok: true }));

    const res = await request(testApp).get("/test");
    expect(res.status).toBe(401);
  });
});
