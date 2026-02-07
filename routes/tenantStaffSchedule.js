// routes/tenantStaffSchedule.js
// PR-S1: Staff Scheduling Foundation (tenant dashboard)
//
// Endpoints (tenant slug scoped):
//   GET    /api/tenant/:slug/staff/:staffId/schedule
//   PUT    /api/tenant/:slug/staff/:staffId/schedule          (replace-all weekly blocks)
//   GET    /api/tenant/:slug/staff/:staffId/overrides?from&to
//   POST   /api/tenant/:slug/staff/:staffId/overrides
//   DELETE /api/tenant/:slug/staff/:staffId/overrides/:overrideId
//
// Notes:
// - tenant isolation is enforced via slug -> tenantId resolution
// - permissions: manager+ (owner/manager)
// - API uses minutes since midnight: start_minute/end_minute
// - DB stores weekly schedule in existing table: staff_weekly_schedule (start_time/end_time as TIME)
// - DB stores date overrides in: staff_schedule_overrides (created by PR-S1 migration)

const express = require("express");
const router = express.Router();

const db = require("../db");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const requireAdmin = require("../middleware/requireAdmin");
const ensureUser = require("../middleware/ensureUser");
const { getTenantIdFromSlug } = require("../utils/tenants");
const { requireTenantRole } = require("../middleware/requireTenantRole");

function extractAdminKey(req) {
  const rawAuth = String(req.headers.authorization || "");
  const bearer = rawAuth.toLowerCase().startsWith("bearer ")
    ? rawAuth.slice(7).trim()
    : null;
  const key =
    bearer ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"] || "").trim();
  return key || null;
}

function isAdminRequest(req) {
  const expected = String(process.env.ADMIN_API_KEY || "").trim();
  if (!expected) return false;
  const key = extractAdminKey(req);
  return !!key && key === expected;
}

// Owner dashboard calls these endpoints via proxy-admin (x-api-key).
// Tenant dashboard calls via Google auth.
function staffScheduleAuth(req, res, next) {
  if (isAdminRequest(req)) return requireAdmin(req, res, next);
  return requireGoogleAuth(req, res, next);
}

function staffScheduleUser(req, res, next) {
  if (isAdminRequest(req)) return next();
  return ensureUser(req, res, next);
}

function staffScheduleRole(req, res, next) {
  if (isAdminRequest(req)) return next();
  return requireTenantRole(["owner", "manager"])(req, res, next);
}

async function resolveTenantIdFromParam(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "Missing tenant slug." });
    const tenantId = await getTenantIdFromSlug(slug);
    if (!tenantId) return res.status(404).json({ error: "Tenant not found." });
    req.tenantSlug = slug;
    req.tenantId = Number(tenantId);
    return next();
  } catch (err) {
    console.error("resolveTenantIdFromParam error:", err);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validateWeekday(w) {
  return Number.isInteger(w) && w >= 0 && w <= 6;
}

function validateMinutes(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || start > 1439) return false;
  if (end < 1 || end > 1440) return false;
  if (end <= start) return false;
  return true;
}

function normalizePgConflict(err) {
  // Exclusion violation (overlap) is 23P01
  if (err && err.code === "23P01") {
    return {
      status: 409,
      body: {
        error: "SCHEDULE_OVERLAP",
        message: "Time block overlaps with an existing block.",
      },
    };
  }
  // Unique violation (duplicate override block) is 23505
  if (err && err.code === "23505") {
    return {
      status: 409,
      body: {
        error: "DUPLICATE_OVERRIDE",
        message: "An override with the same values already exists.",
      },
    };
  }
  return null;
}

function isAdminRequest(req) {
  const expected = String(process.env.ADMIN_API_KEY || "").trim();
  if (!expected) return false;

  const rawAuth = String(req.headers.authorization || "");
  const bearer = rawAuth.toLowerCase().startsWith("bearer ")
    ? rawAuth.slice(7).trim()
    : "";

  const key =
    String(bearer || "").trim() ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"] || "").trim();

  return !!key && key === expected;
}

// Auth wrappers: allow either Google (tenant staff) OR ADMIN_API_KEY (owner proxy-admin).
function requireStaffScheduleAuth(req, res, next) {
  if (isAdminRequest(req)) return requireAdmin(req, res, next);
  return requireGoogleAuth(req, res, next);
}

function maybeEnsureUser(req, res, next) {
  if (isAdminRequest(req)) return next();
  return ensureUser(req, res, next);
}

const requireManagerRole = requireTenantRole(["owner", "manager"]);
function maybeRequireManagerRole(req, res, next) {
  if (isAdminRequest(req)) return next();
  return requireManagerRole(req, res, next);
}

async function assertStaffInTenant(tenantId, staffId) {
  const q = await db.query(
    `SELECT id FROM staff WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [staffId, tenantId]
  );
  return !!q.rows?.length;
}

// -----------------------------------------------------------------------------
// GET /api/tenant/:slug/staff/:staffId/schedule
// -----------------------------------------------------------------------------
router.get(
  "/:slug/staff/:staffId/schedule",
  requireStaffScheduleAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  maybeRequireManagerRole,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const staffId = asInt(req.params.staffId);
      if (!staffId) return res.status(400).json({ error: "Invalid staff id." });

      const ok = await assertStaffInTenant(tenantId, staffId);
      if (!ok) return res.status(404).json({ error: "Staff not found." });

      // Weekly schedule is stored in existing table staff_weekly_schedule as TIME fields.
      // Convert TIME -> minutes for API response.
      const r = await db.query(
        `
        SELECT
          id,
          day_of_week AS weekday,
          (EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int) AS start_minute,
          (EXTRACT(HOUR FROM end_time)::int * 60 + EXTRACT(MINUTE FROM end_time)::int) AS end_minute
        FROM staff_weekly_schedule
        WHERE tenant_id = $1
          AND staff_id = $2
          AND COALESCE(is_off, false) = false
          AND start_time IS NOT NULL
          AND end_time IS NOT NULL
        ORDER BY day_of_week ASC, start_time ASC
        `,
        [tenantId, staffId]
      );

      return res.json({ staffId, weekly: r.rows || [] });
    } catch (err) {
      console.error("GET staff schedule error:", err);
      return res.status(500).json({ error: "Failed to load staff schedule." });
    }
  }
);

// -----------------------------------------------------------------------------
// PUT /api/tenant/:slug/staff/:staffId/schedule
// Replace-all weekly schedule blocks for staff
// Body: { weekly: [{ weekday, start_minute, end_minute }, ...] }
// -----------------------------------------------------------------------------
router.put(
  "/:slug/staff/:staffId/schedule",
  requireStaffScheduleAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  maybeRequireManagerRole,
  async (req, res) => {
    const client = await db.pool.connect();
    try {
      const tenantId = req.tenantId;
      const staffId = asInt(req.params.staffId);
      if (!staffId) return res.status(400).json({ error: "Invalid staff id." });

      const ok = await assertStaffInTenant(tenantId, staffId);
      if (!ok) return res.status(404).json({ error: "Staff not found." });

      const weekly = Array.isArray(req.body?.weekly) ? req.body.weekly : null;
      if (!weekly) return res.status(400).json({ error: "Missing weekly array." });

      for (const b of weekly) {
        const weekday = asInt(b?.weekday);
        const start = asInt(b?.start_minute);
        const end = asInt(b?.end_minute);
        if (weekday == null || start == null || end == null) {
          return res.status(400).json({ error: "Invalid block. Missing fields." });
        }
        if (!validateWeekday(weekday) || !validateMinutes(start, end)) {
          return res.status(400).json({ error: "Invalid block values." });
        }
      }

      // Overlap validation (SaaS-grade): prevent overlapping blocks per weekday.
      // staff_weekly_schedule does not guarantee this at the DB level in all environments.
      const byDay = new Map();
      for (const b of weekly) {
        const w = Number(b.weekday);
        const arr = byDay.get(w) || [];
        arr.push({ start: Number(b.start_minute), end: Number(b.end_minute) });
        byDay.set(w, arr);
      }
      for (const [w, arr] of byDay.entries()) {
        arr.sort((a, b) => a.start - b.start);
        for (let i = 1; i < arr.length; i++) {
          if (arr[i].start < arr[i - 1].end) {
            return res.status(409).json({
              error: "SCHEDULE_OVERLAP",
              message: `Time block overlaps with an existing block (weekday ${w}).`,
            });
          }
        }
      }

      await client.query("BEGIN");
      // Replace-all weekly schedule.
      // We delete all weekly rows for this staff and reinsert.
      await client.query(
        `DELETE FROM staff_weekly_schedule WHERE tenant_id = $1 AND staff_id = $2`,
        [tenantId, staffId]
      );

      if (weekly.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const b of weekly) {
          params.push(tenantId, staffId, Number(b.weekday), Number(b.start_minute), Number(b.end_minute));
          values.push(
            `($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
          );
        }

        // Insert as TIME using minutes -> time '00:00' + interval.
        await client.query(
          `
          INSERT INTO staff_weekly_schedule (tenant_id, staff_id, day_of_week, start_time, end_time, is_off, note)
          VALUES ${values
            .map((_, idx) => {
              // Every block contributes 5 params: tenant_id, staff_id, weekday, start_minute, end_minute
              // We need to transform start/end minute params into TIME inside SQL.
              // For each block, the param positions are offset by 5.
              const base = idx * 5;
              return `($${base + 1}, $${base + 2}, $${base + 3}, (time '00:00' + make_interval(mins => $${base + 4}))::time, (time '00:00' + make_interval(mins => $${base + 5}))::time, false, NULL)`;
            })
            .join(",")}
          `,
          params
        );
      }

      await client.query("COMMIT");

      const r = await db.query(
        `
        SELECT
          id,
          day_of_week AS weekday,
          (EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int) AS start_minute,
          (EXTRACT(HOUR FROM end_time)::int * 60 + EXTRACT(MINUTE FROM end_time)::int) AS end_minute
        FROM staff_weekly_schedule
        WHERE tenant_id = $1
          AND staff_id = $2
          AND COALESCE(is_off, false) = false
          AND start_time IS NOT NULL
          AND end_time IS NOT NULL
        ORDER BY day_of_week ASC, start_time ASC
        `,
        [tenantId, staffId]
      );

      return res.json({ staffId, weekly: r.rows || [] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const mapped = normalizePgConflict(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      console.error("PUT staff schedule error:", err);
      return res.status(500).json({ error: "Failed to save staff schedule." });
    } finally {
      client.release();
    }
  }
);

// -----------------------------------------------------------------------------
// GET /api/tenant/:slug/staff/:staffId/overrides?from=YYYY-MM-DD&to=YYYY-MM-DD
// -----------------------------------------------------------------------------
router.get(
  "/:slug/staff/:staffId/overrides",
  requireStaffScheduleAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  maybeRequireManagerRole,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const staffId = asInt(req.params.staffId);
      if (!staffId) return res.status(400).json({ error: "Invalid staff id." });
      const ok = await assertStaffInTenant(tenantId, staffId);
      if (!ok) return res.status(404).json({ error: "Staff not found." });

      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();

      // If not provided, default to [today, today+30]
      const today = new Date();
      const isoToday = today.toISOString().slice(0, 10);
      const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : isoToday;
      const toDate = /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null;
      const toDateFinal = toDate
        ? toDate
        : new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const r = await db.query(
        `
        SELECT
          id,
          date,
          type,
          CASE
            WHEN start_time IS NULL THEN NULL
            ELSE (EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int)
          END AS start_minute,
          CASE
            WHEN end_time IS NULL THEN NULL
            ELSE (EXTRACT(HOUR FROM end_time)::int * 60 + EXTRACT(MINUTE FROM end_time)::int)
          END AS end_minute
        FROM staff_schedule_overrides
        WHERE tenant_id = $1
          AND staff_id = $2
          AND date >= $3::date
          AND date <= $4::date
        ORDER BY date ASC, start_time ASC NULLS FIRST
        `,
        [tenantId, staffId, fromDate, toDateFinal]
      );

      return res.json({ staffId, overrides: r.rows || [] });
    } catch (err) {
      console.error("GET staff overrides error:", err);
      return res.status(500).json({ error: "Failed to load overrides." });
    }
  }
);

// -----------------------------------------------------------------------------
// POST /api/tenant/:slug/staff/:staffId/overrides
// Body: { date, type, start_minute?, end_minute? }
// -----------------------------------------------------------------------------
router.post(
  "/:slug/staff/:staffId/overrides",
  requireStaffScheduleAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  maybeRequireManagerRole,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const staffId = asInt(req.params.staffId);
      if (!staffId) return res.status(400).json({ error: "Invalid staff id." });
      const ok = await assertStaffInTenant(tenantId, staffId);
      if (!ok) return res.status(404).json({ error: "Staff not found." });

      const date = String(req.body?.date || "").trim();
      const type = String(req.body?.type || "").trim().toUpperCase();
      const start = req.body?.start_minute != null ? asInt(req.body.start_minute) : null;
      const end = req.body?.end_minute != null ? asInt(req.body.end_minute) : null;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD." });
      }
      if (!new Set(["OFF", "CUSTOM_HOURS", "ADD_HOURS"]).has(type)) {
        return res.status(400).json({ error: "Invalid override type." });
      }

      if (type === "OFF") {
        if (start != null || end != null) {
          return res.status(400).json({ error: "OFF overrides must not include time fields." });
        }
      } else {
        if (start == null || end == null || !validateMinutes(start, end)) {
          return res.status(400).json({ error: "Invalid minutes for override." });
        }
      }

      const r = await db.query(
        `
        INSERT INTO staff_schedule_overrides
          (tenant_id, staff_id, date, type, start_time, end_time)
        VALUES
          (
            $1,
            $2,
            $3::date,
            $4,
            CASE WHEN $5::int IS NULL THEN NULL ELSE (time '00:00' + make_interval(mins => $5::int))::time END,
            CASE WHEN $6::int IS NULL THEN NULL ELSE (time '00:00' + make_interval(mins => $6::int))::time END
          )
        RETURNING
          id,
          date,
          type,
          CASE WHEN start_time IS NULL THEN NULL ELSE (EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int) END AS start_minute,
          CASE WHEN end_time IS NULL THEN NULL ELSE (EXTRACT(HOUR FROM end_time)::int * 60 + EXTRACT(MINUTE FROM end_time)::int) END AS end_minute
        `,
        [tenantId, staffId, date, type, start, end]
      );

      return res.status(201).json({ staffId, override: r.rows[0] });
    } catch (err) {
      const mapped = normalizePgConflict(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      console.error("POST staff override error:", err);
      return res.status(500).json({ error: "Failed to create override." });
    }
  }
);

// -----------------------------------------------------------------------------
// DELETE /api/tenant/:slug/staff/:staffId/overrides/:overrideId
// -----------------------------------------------------------------------------
router.delete(
  "/:slug/staff/:staffId/overrides/:overrideId",
  requireStaffScheduleAuth,
  maybeEnsureUser,
  resolveTenantIdFromParam,
  maybeRequireManagerRole,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const staffId = asInt(req.params.staffId);
      const overrideId = asInt(req.params.overrideId);
      if (!staffId || !overrideId) return res.status(400).json({ error: "Invalid id." });

      const ok = await assertStaffInTenant(tenantId, staffId);
      if (!ok) return res.status(404).json({ error: "Staff not found." });

      const r = await db.query(
        `
        DELETE FROM staff_schedule_overrides
        WHERE id = $1 AND tenant_id = $2 AND staff_id = $3
        RETURNING id
        `,
        [overrideId, tenantId, staffId]
      );

      if (!r.rows?.length) return res.status(404).json({ error: "Override not found." });
      return res.status(204).send();
    } catch (err) {
      console.error("DELETE staff override error:", err);
      return res.status(500).json({ error: "Failed to delete override." });
    }
  }
);

module.exports = router;
