// routes/tenantHours.js
const express = require("express");
const router = express.Router();
const db = pool;

const { pool } = require("../db");
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
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tenantSlug, tenantId, dayOfWeek, openTime, closeTime, isClosed } =
      req.body || {};

    if (typeof dayOfWeek !== "number" || dayOfWeek < 0 || dayOfWeek > 6) {
      return res
        .status(400)
        .json({ error: "dayOfWeek must be 0–6 (0 = Sunday)." });
    }

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
