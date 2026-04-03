// routes/tenantStaffSchedule/schedule.js
// GET/PUT /:slug/staff/:staffId/schedule
// Mounted by routes/tenantStaffSchedule.js

const db = require("../../db");
const {
  extractAdminKey, isAdminRequest, staffScheduleAuth, staffScheduleUser, staffScheduleRole,
  resolveTenantIdFromParam, asInt, validateWeekday, validateMinutes, normalizePgConflict,
  requireStaffScheduleAuth, maybeEnsureUser, maybeRequireManagerRole, assertStaffInTenant,
} = require("../../utils/staffScheduleHelpers");


module.exports = function mount(router) {
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
	      // If the overrides table hasn't been migrated yet, don't hard-fail the UI.
	      // Return an empty list so schedules can still be edited.
	      if (err && err.code === "42P01") {
	        return res.json({ staffId: asInt(req.params.staffId), overrides: [], warning: "overrides_table_missing" });
	      }
	      console.error("GET staff overrides error:", err);
	      return res.status(500).json({ error: "Failed to load overrides." });
	    }
  }
);

// -----------------------------------------------------------------------------
// POST /api/tenant/:slug/staff/:staffId/overrides
// Body: { date, type, start_minute?, end_minute? }
// -----------------------------------------------------------------------------
};
