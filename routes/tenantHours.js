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

    // 🔧 Fallback: infer tenantId from hours rows (frontend sends it here)
    if (
      !resolvedTenantId &&
      Array.isArray(body.hours) &&
      body.hours.length
    ) {
      const rowTenantId =
        body.hours[0]?.tenant_id ??
        body.hours[0]?.tenantId ??
        body.hours[0]?.tenantID ??
        null;
    
      if (rowTenantId != null) {
        resolvedTenantId = Number(rowTenantId);
      }
    }

    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }

    if (!resolvedTenantId) {
      return res.status(400).json({ error: "You must provide tenantSlug or tenantId." });
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

    // Accept tenantSlug/tenantId in multiple key styles
    const tenantSlug = body.tenantSlug ?? body.slug ?? body.tenant_slug ?? null;

    const tenantIdRaw =
      body.tenantId ??
      body.tenant_id ??
      body.tenantID ??
      null;

    let resolvedTenantId = tenantIdRaw != null ? Number(tenantIdRaw) : null;

    // If not provided at top-level, infer from hours[0]
    if (!resolvedTenantId && Array.isArray(body.hours) && body.hours.length) {
      const rowTenantId =
        body.hours[0]?.tenant_id ??
        body.hours[0]?.tenantId ??
        body.hours[0]?.tenantID ??
        null;

      if (rowTenantId != null) resolvedTenantId = Number(rowTenantId);
    }

    // Or resolve from slug
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "You must provide tenantSlug or tenantId." });
    }

    // ---------- BULK SAVE ----------
    if (body.hours != null) {
      const hours = body.hours;
      const saved = [];

      await db.query("BEGIN");
      try {
        // (A) hours as ARRAY (your current frontend)
        if (Array.isArray(hours)) {
          for (const row of hours) {
            const dayOfWeek = Number(row?.day_of_week ?? row?.dayOfWeek);
            if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;

            const isClosed = Boolean(row?.is_closed ?? row?.isClosed);
            const openTime = isClosed ? null : (row?.open_time ?? row?.openTime ?? null);
            const closeTime = isClosed ? null : (row?.close_time ?? row?.closeTime ?? null);

            const r = await db.query(
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

            saved.push(r.rows[0]);
          }

          await db.query("COMMIT");
          return res.json({ hours: saved });
        }

        // (B) hours as MAP (sun..sat)
        if (hours && typeof hours === "object") {
          const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

          for (const [dayKey, conf] of Object.entries(hours)) {
            const dayOfWeek = dayMap[dayKey];
            if (typeof dayOfWeek !== "number") continue;

            const isClosed = Boolean(conf?.closed);
            const openTime = isClosed ? null : (conf?.open || null);
            const closeTime = isClosed ? null : (conf?.close || null);

            const r = await db.query(
              `
              INSERT INTO tenant_hours (tenant_id, day_of_week, open_time, close_time, is_closed)
 reopening_time = EXCLUDED.open_time,
                close_time = EXCLUDED.close_time,
                is_closed  = EXCLUDED.is_closed
              RETURNING id, tenant_id, day_of_week, open_time, close_time, is_closed
              `,
              [resolvedTenantId, dayOfWeek, openTime, closeTime, isClosed]
            );

            saved.push(r.rows[0]);
          }

          await db.query("COMMIT");
          return res.json({ hours: saved });
        }

        await db.query("ROLLBACK");
        return res.status(400).json({ error: "Invalid hours payload." });
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    }

    // ---------- SINGLE DAY SAVE ----------
    const { dayOfWeek, openTime, closeTime, isClosed } = body;

    if (typeof dayOfWeek !== "number" || dayOfWeek < 0 || dayOfWeek > 6) {
      return res.status(400).json({ error: "dayOfWeek must be 0–6 (0 = Sunday)." });
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
    console.error("Error saving tenant hours:", err);
    return res.status(500).json({ error: "Failed to save tenant hours." });
  }
});

module.exports = router;
