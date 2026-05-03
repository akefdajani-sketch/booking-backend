// routes/serviceHours.js
// PR-SH1: Per-service time windows (restrict a service to a subset of business hours)
//
// Endpoints (tenant-slug scoped, manager+):
//   GET  /api/tenant/:slug/services/:serviceId/hours
//        → [ { day_of_week, open_time, close_time }, … ]
//          No rows = unrestricted (full business hours apply)
//
//   PUT  /api/tenant/:slug/services/:serviceId/hours
//        Body: { windows: [ { day_of_week, open_time, close_time }, … ] }
//        Full-replace: deletes all existing rows for this service, inserts new ones.
//        Send an empty windows array to clear all restrictions.

"use strict";

const express = require("express");
const router  = express.Router();
const pool    = require("../db");

const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const requireAppAuth    = require("../middleware/requireAppAuth"); // AUTH-FIX: Flexrz JWT + Google fallback + admin bypass
const requireAdmin      = require("../middleware/requireAdmin");
const ensureUser        = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole }   = require("../middleware/requireTenantRole");
// VOICE-PERF-1: Bust AI context on service-hour writes.
const aiContextCache = require("../utils/aiContextCache");

// ─── auth helpers (mirrors tenantStaffSchedule.js pattern) ───────────────────

function extractAdminKey(req) {
  const rawAuth = String(req.headers.authorization || "");
  const bearer  = rawAuth.toLowerCase().startsWith("bearer ") ? rawAuth.slice(7).trim() : null;
  return (
    bearer ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"]   || "").trim() ||
    null
  );
}

function isAdminRequest(req) {
  const expected = String(process.env.ADMIN_API_KEY || "").trim();
  if (!expected) return false;
  const key = extractAdminKey(req);
  return !!key && key === expected;
}

function shAuth(req, res, next) {
  return isAdminRequest(req) ? requireAdmin(req, res, next) : requireAppAuth(req, res, next);
}
function shUser(req, res, next) {
  return isAdminRequest(req) ? next() : ensureUser(req, res, next);
}
function shRole(req, res, next) {
  return isAdminRequest(req) ? next() : requireTenantRole("manager")(req, res, next);
}

// ─── tenant resolution ────────────────────────────────────────────────────────

async function resolveTenant(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug." });
    const tenantId = await getTenantIdFromSlug(slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found." });
    req.tenantSlug = slug;
    req.tenantId   = Number(tenantId);
    req.tenant     = { id: Number(tenantId), slug };
    return next();
  } catch (err) {
    console.error("serviceHours resolveTenant:", err);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

// ─── validation helpers ───────────────────────────────────────────────────────

function isValidHHMM(v) {
  return typeof v === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(v.trim());
}

function normaliseTime(v) {
  // Accept "HH:MM" or "HH:MM:SS", always store as "HH:MM"
  return String(v).trim().slice(0, 5);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return (h * 60) + m;
}

// ─── GET /api/tenant/:slug/services/:serviceId/hours ─────────────────────────

router.get(
  "/:slug/services/:serviceId/hours",
  shAuth, shUser, resolveTenant, shRole,
  async (req, res) => {
    try {
      const serviceId = Number(req.params.serviceId);
      if (!Number.isFinite(serviceId)) {
        return res.status(400).json({ error: "Invalid serviceId." });
      }

      // Verify service belongs to this tenant
      const svcCheck = await pool.query(
        "SELECT id FROM services WHERE id = $1 AND tenant_id = $2 LIMIT 1",
        [serviceId, req.tenantId]
      );
      if (!svcCheck.rows.length) {
        return res.status(404).json({ error: "Service not found." });
      }

      const windowsResult = await pool.query(
        `SELECT day_of_week,
                to_char(open_time,  'HH24:MI') AS open_time,
                to_char(close_time, 'HH24:MI') AS close_time
           FROM service_hours
          WHERE service_id = $1
            AND tenant_id  = $2
          ORDER BY day_of_week ASC, open_time ASC`,
        [serviceId, req.tenantId]
      );

      let disabledDays = [];
      try {
        const disabledResult = await pool.query(
          `SELECT day_of_week
             FROM service_closed_days
            WHERE service_id = $1
              AND tenant_id  = $2
            ORDER BY day_of_week ASC`,
          [serviceId, req.tenantId]
        );
        disabledDays = disabledResult.rows.map((r) => Number(r.day_of_week)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      } catch (disabledErr) {
        if (!disabledErr || disabledErr.code !== "42P01") throw disabledErr;
      }

      return res.json({ windows: windowsResult.rows, disabled_days: disabledDays });
    } catch (err) {
      // If the table hasn't been migrated yet, return empty (graceful degradation)
      if (err && err.code === "42P01") {
        return res.json({ windows: [], disabled_days: [] });
      }
      console.error("GET service hours error:", err);
      return res.status(500).json({ error: "Failed to load service hours." });
    }
  }
);

// ─── PUT /api/tenant/:slug/services/:serviceId/hours ─────────────────────────

router.put(
  "/:slug/services/:serviceId/hours",
  shAuth, shUser, resolveTenant, shRole,
  async (req, res) => {
    try {
      const serviceId = Number(req.params.serviceId);
      if (!Number.isFinite(serviceId)) {
        return res.status(400).json({ error: "Invalid serviceId." });
      }

      // Verify service belongs to this tenant
      const svcCheck = await pool.query(
        "SELECT id FROM services WHERE id = $1 AND tenant_id = $2 LIMIT 1",
        [serviceId, req.tenantId]
      );
      if (!svcCheck.rows.length) {
        return res.status(404).json({ error: "Service not found." });
      }

      const rawWindows = req.body?.windows;
      const rawDisabledDays = req.body?.disabled_days;
      if (!Array.isArray(rawWindows)) {
        return res.status(400).json({ error: "Body must contain { windows: [] }." });
      }
      if (rawDisabledDays != null && !Array.isArray(rawDisabledDays)) {
        return res.status(400).json({ error: "disabled_days must be an array when provided." });
      }

      const disabledDays = Array.from(new Set((rawDisabledDays ?? []).map((v) => Number(v))));
      for (const dow of disabledDays) {
        if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
          return res.status(400).json({ error: `Invalid disabled day_of_week: ${dow}` });
        }
      }

      // Validate each window
      const windows = [];
      for (const w of rawWindows) {
        const dow = Number(w.day_of_week);
        if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
          return res.status(400).json({ error: `Invalid day_of_week: ${w.day_of_week}` });
        }
        if (!isValidHHMM(w.open_time) || !isValidHHMM(w.close_time)) {
          return res.status(400).json({
            error: `Invalid time format on day ${dow}. Use HH:MM.`,
          });
        }
        const open  = normaliseTime(w.open_time);
        const close = normaliseTime(w.close_time);
        const openMin = toMinutes(open);
        const closeMin = toMinutes(close);
        if (!Number.isFinite(openMin) || !Number.isFinite(closeMin)) {
          return res.status(400).json({
            error: `Invalid time value on day ${dow}. Use HH:MM.`,
          });
        }
        if (openMin === closeMin) {
          return res.status(400).json({
            error: `open_time and close_time cannot be the same on day ${dow}.`,
          });
        }
        windows.push({ day_of_week: dow, open_time: open, close_time: close });
      }

      // Full replace in a transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          "DELETE FROM service_hours WHERE service_id = $1 AND tenant_id = $2",
          [serviceId, req.tenantId]
        );

        try {
          await client.query(
            "DELETE FROM service_closed_days WHERE service_id = $1 AND tenant_id = $2",
            [serviceId, req.tenantId]
          );
        } catch (closedErr) {
          if (!closedErr || closedErr.code !== "42P01") throw closedErr;
        }

        for (const dow of disabledDays) {
          try {
            await client.query(
              `INSERT INTO service_closed_days (service_id, tenant_id, day_of_week)
               VALUES ($1, $2, $3)`,
              [serviceId, req.tenantId, dow]
            );
          } catch (closedInsertErr) {
            if (!closedInsertErr || closedInsertErr.code !== "42P01") throw closedInsertErr;
          }
        }

        for (const w of windows) {
          await client.query(
            `INSERT INTO service_hours (service_id, tenant_id, day_of_week, open_time, close_time)
             VALUES ($1, $2, $3, $4::time, $5::time)`,
            [serviceId, req.tenantId, w.day_of_week, w.open_time, w.close_time]
          );
        }

        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }

      aiContextCache.bustBusiness(req.tenantId);
      return res.json({ ok: true, windows, disabled_days: disabledDays });
    } catch (err) {
      if (err && err.code === "42P01") {
        // Table not yet migrated — return OK so the UI doesn't break
        return res.json({ ok: true, windows: [], disabled_days: [], note: "migration_pending" });
      }
      console.error("PUT service hours error:", err);
      return res.status(500).json({ error: "Failed to save service hours." });
    }
  }
);

module.exports = router;
