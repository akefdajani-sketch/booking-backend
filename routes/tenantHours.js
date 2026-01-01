// routes/tenantHours.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const { getTenantIdFromSlug } = require("../utils/tenants");

// ---------------------------------------------------------------------------
// Tenant working hours
// ---------------------------------------------------------------------------

// GET /api/tenant-hours?tenantSlug=&tenantId=
// NOTE: your index.js had this incorrectly as POST. This router fixes it to GET.
router.get("/", requireAdmin, async (req, res) => {
  try {
    const { tenantSlug, tenantId } = req.query;
    let resolvedTenantId = tenantId ? Number(tenantId) : null;

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    const result = await db.query(
      `
      SELECT
        id,
        day_of_week,
        open_time,
        close_time,
        is_closed
      FROM tenant_hours
      WHERE tenant_id = $1
      ORDER BY day_of_week ASC
      `,
      [resolvedTenantId]
    );

    return res.json({ hours: result.rows });
  } catch (err) {
    console.error("Error loading tenant hours:", err);
    return res.status(500).json({ error: "Failed to load tenant hours." });
  }
});

// POST /api/tenant-hours
// Body: { tenantSlug? | tenantId?, dayOfWeek, openTime?, closeTime?, isClosed? }
// POST /api/tenant-hours
// Supports BOTH payload shapes:
//
// 1) Single day:
// {
//   tenantSlug?: string,
//   tenantId?: number,
//   dayOfWeek: 0..6,
//   openTime?: "HH:MM",
//   closeTime?: "HH:MM",
//   isClosed?: boolean
// }
//
// 2) Bulk (Setup tab):
// {
//   tenantSlug?: string,
//   tenantId?: number,
//   hours: {
//     sun: { open: "08:00", close: "22:00", closed: false },
//     mon: { open: "08:00", close: "22:00", closed: false },
//     ...
//     sat: { open: "08:00", close: "22:00", closed: false }
//   }
// }
router.post("/", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const { tenantSlug, tenantId } = body;

    // Resolve tenant id
    let resolvedTenantId = tenantId ? Number(tenantId) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }
    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    // ----------------------------
    // BULK SAVE (Setup tab)
    // ----------------------------
    if (body.hours && typeof body.hours === "object") {
      const hours = body.hours;

      const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

      // Use a transaction so all 7 updates are consistent
      await db.query("BEGIN");

      const saved = [];

      for (const [dayKey, conf] of Object.entries(hours)) {
        const dayOfWeek = dayMap[dayKey];
        if (typeof dayOfWeek !== "number") continue;

        const closed = Boolean(conf?.closed);
        const openTime = closed ? null : (conf?.open || null);
        const closeTime = closed ? null : (conf?.close || null);
        const isClosed = closed;

        const result = await db.query(
          `
          INSERT INTO tenant_hours (tenant_id, day_of_week, open_time, close_time, is_closed)
          VALUES ($1, $2, $3::time, $4::time, $5)
          ON CONFLICT (tenant_id, day_of_week)
          DO UPDATE SET
            open_time  = EXCLUDED.open_time,
            close_time = EXCLUDED.close_time,
            is_closed  = EXCLUDED.is_closed
          RETURNING id, tenant_id, day_of_week, open_time, close_time, is_closed
          `,
          [resolvedTenantId, dayOfWeek, openTime, closeTime, isClosed]
        );

        saved.push(result.rows[0]);
      }

      await db.query("COMMIT");
      return res.json({ hours: saved });
    }

    // ----------------------------
    // SINGLE DAY SAVE (existing behavior)
    // ----------------------------
    const { dayOfWeek, openTime, closeTime, isClosed } = body;

    if (typeof dayOfWeek !== "number" || dayOfWeek < 0 || dayOfWeek > 6) {
      return res
        .status(400)
        .json({ error: "dayOfWeek must be 0–6 (0 = Sunday)." });
    }

    const result = await db.query(
      `
      INSERT INTO tenant_hours (tenant_id, day_of_week, open_time, close_time, is_closed)
      VALUES ($1, $2, $3::time, $4::time, COALESCE($5, FALSE))
      ON CONFLICT (tenant_id, day_of_week)
      DO UPDATE SET
        open_time  = EXCLUDED.open_time,
        close_time = EXCLUDED.close_time,
        is_closed  = EXCLUDED.is_closed
      RETURNING id, tenant_id, day_of_week, open_time, close_time, is_closed
      `,
      [
        resolvedTenantId,
        dayOfWeek,
        openTime || null,
        closeTime || null,
        typeof isClosed === "boolean" ? isClosed : false,
      ]
    );

    return res.json({ hour: result.rows[0] });
  } catch (err) {
    // If we started a transaction and something failed, rollback safely.
    try {
      await db.query("ROLLBACK");
    } catch (_) {}

    console.error("Error saving tenant hours:", err);
    return res.status(500).json({ error: "Failed to save tenant hours." });
  }
});

module.exports = router;
