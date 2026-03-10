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
const requireAdmin      = require("../middleware/requireAdmin");
const ensureUser        = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole }   = require("../middleware/requireTenantRole");

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
  return isAdminRequest(req) ? requireAdmin(req, res, next) : requireGoogleAuth(req, res, next);
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

// ─── GET /api/tenant/:slug/services/:serviceId/hours ─────────────────────────

router.get(
  "/:slug/services/:serviceId/hours",
  shAuth, shUser, shRole, resolveTenant,
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

      const result = await pool.query(
        `SELECT day_of_week,
                to_char(open_time,  'HH24:MI') AS open_time,
                to_char(close_time, 'HH24:MI') AS close_time
           FROM service_hours
          WHERE service_id = $1
            AND tenant_id  = $2
          ORDER BY day_of_week ASC, open_time ASC`,
        [serviceId, req.tenantId]
      );

      return res.json({ windows: result.rows });
    } catch (err) {
      // If the table hasn't been migrated yet, return empty (graceful degradation)
      if (err && err.code === "42P01") {
        return res.json({ windows: [] });
      }
      console.error("GET service hours error:", err);
      return res.status(500).json({ error: "Failed to load service hours." });
    }
  }
);

// ─── PUT /api/tenant/:slug/services/:serviceId/hours ─────────────────────────

router.put(
  "/:slug/services/:serviceId/hours",
  shAuth, shUser, shRole, resolveTenant,
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
      if (!Array.isArray(rawWindows)) {
        return res.status(400).json({ error: "Body must contain { windows: [] }." });
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
        if (close <= open) {
          return res.status(400).json({
            error: `close_time must be after open_time on day ${dow}.`,
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

      return res.json({ ok: true, windows });
    } catch (err) {
      if (err && err.code === "42P01") {
        // Table not yet migrated — return OK so the UI doesn't break
        return res.json({ ok: true, windows: [], note: "migration_pending" });
      }
      console.error("PUT service hours error:", err);
      return res.status(500).json({ error: "Failed to save service hours." });
    }
  }
);

module.exports = router;
