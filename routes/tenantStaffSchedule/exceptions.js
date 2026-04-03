// routes/tenantStaffSchedule/exceptions.js
// GET/POST/DELETE /:slug/staff/:staffId/exceptions
// Mounted by routes/tenantStaffSchedule.js

const db = require("../../db");
const {
  extractAdminKey, isAdminRequest, staffScheduleAuth, staffScheduleUser, staffScheduleRole,
  resolveTenantIdFromParam, asInt, validateWeekday, validateMinutes, normalizePgConflict,
  requireStaffScheduleAuth, maybeEnsureUser, maybeRequireManagerRole, assertStaffInTenant,
} = require("../../utils/staffScheduleHelpers");


module.exports = function mount(router) {
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
	      if (err && err.code === "42P01") {
	        return res.status(409).json({
	          error: "Overrides table missing. Run the PR-S1 migration to enable exceptions.",
	          code: "overrides_table_missing",
	        });
	      }
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
	      if (err && err.code === "42P01") {
	        return res.status(409).json({
	          error: "Overrides table missing. Run the PR-S1 migration to enable exceptions.",
	          code: "overrides_table_missing",
	        });
	      }
	      console.error("DELETE staff override error:", err);
	      return res.status(500).json({ error: "Failed to delete override." });
	    }
  }
);
};
