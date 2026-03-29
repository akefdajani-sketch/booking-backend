// routes/sessions.js
// PR-SESSIONS: Owner API for group/parallel booking sessions
//
// GET  /api/tenant/:slug/sessions          – list sessions (with participant counts)
// GET  /api/tenant/:slug/sessions/:id      – session detail with participant list
// POST /api/tenant/:slug/sessions/:id/cancel – cancel a session + all its bookings

"use strict";

const express = require("express");
const router  = express.Router({ mergeParams: true });
const { pool } = require("../db");
const db = pool;

const requireGoogleAuth            = require("../middleware/requireGoogleAuth");
const requireAppAuth = require("../middleware/requireAppAuth"); // AUTH-FIX
const requireAdminOrTenantRole     = require("../middleware/requireAdminOrTenantRole");
const { requireTenant }            = require("../middleware/requireTenant");

// ── Shared helpers ────────────────────────────────────────────────────────────

function injectTenantSlug(req, _res, next) {
  req.query = req.query || {};
  req.query.tenantSlug = req.params.slug;
  next();
}

const baseMiddleware = [
  requireAppAuth,
  injectTenantSlug,
  requireTenant,
  requireAdminOrTenantRole("staff"),
];

// ─── GET /api/tenant/:slug/sessions ──────────────────────────────────────────
// List sessions for a tenant, optionally filtered by date, service, or resource.
router.get("/:slug/sessions", ...baseMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const {
      date,        // YYYY-MM-DD – filter sessions starting on this date (tenant tz)
      serviceId,
      resourceId,
      status,      // open | full | cancelled | all (default: open,full)
      limit  = 50,
      offset = 0,
    } = req.query;

    const params  = [tenantId];
    const filters = [];

    if (serviceId) {
      params.push(Number(serviceId));
      filters.push(`ss.service_id = $${params.length}`);
    }
    if (resourceId) {
      params.push(Number(resourceId));
      filters.push(`ss.resource_id = $${params.length}`);
    }
    if (status && status !== "all") {
      const statuses = status.split(",").map(s => s.trim()).filter(Boolean);
      params.push(statuses);
      filters.push(`ss.status = ANY($${params.length})`);
    } else if (!status) {
      filters.push(`ss.status IN ('open','full')`);
    }
    if (date) {
      const tzRes = await db.query(
        `SELECT timezone FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );
      const tz = tzRes.rows[0]?.timezone || "UTC";
      params.push(date);
      params.push(tz);
      filters.push(
        `DATE(ss.start_time AT TIME ZONE $${params.length}) = $${params.length - 1}::date`
      );
    }

    const whereClause = filters.length ? `AND ${filters.join(" AND ")}` : "";

    params.push(Number(limit) || 50, Number(offset) || 0);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const q = `
      SELECT
        ss.id,
        ss.tenant_id,
        ss.service_id,
        s.name  AS service_name,
        ss.resource_id,
        r.name  AS resource_name,
        ss.staff_id,
        st.name AS staff_name,
        ss.start_time,
        ss.duration_minutes,
        ss.max_capacity,
        ss.confirmed_count,
        ss.status,
        ss.created_at,
        COUNT(b.id) FILTER (WHERE b.status IN ('pending','confirmed')) AS active_bookings,
        COUNT(b.id) FILTER (WHERE b.status = 'cancelled')              AS cancelled_bookings
      FROM service_sessions ss
      JOIN tenants t   ON t.id   = ss.tenant_id
      LEFT JOIN services  s  ON s.id  = ss.service_id  AND s.tenant_id  = ss.tenant_id
      LEFT JOIN resources r  ON r.id  = ss.resource_id AND r.tenant_id  = ss.tenant_id
      LEFT JOIN staff     st ON st.id = ss.staff_id    AND st.tenant_id = ss.tenant_id
      LEFT JOIN bookings  b  ON b.session_id = ss.id   AND b.deleted_at IS NULL
      WHERE ss.tenant_id = $1
        ${whereClause}
      GROUP BY ss.id, s.name, r.name, st.name
      ORDER BY ss.start_time ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const result = await db.query(q, params);
    return res.json({ sessions: result.rows });
  } catch (err) {
    console.error("sessions GET list error:", err);
    return res.status(500).json({ error: "Failed to load sessions." });
  }
});

// ─── GET /api/tenant/:slug/sessions/:id ──────────────────────────────────────
// Session detail with full participant booking list.
router.get("/:slug/sessions/:id", ...baseMiddleware, async (req, res) => {
  try {
    const tenantId  = req.tenantId;
    const sessionId = Number(req.params.id);

    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: "Invalid session id." });
    }

    const sessionRes = await db.query(
      `SELECT
         ss.*,
         s.name  AS service_name,
         r.name  AS resource_name,
         st.name AS staff_name
       FROM service_sessions ss
       LEFT JOIN services  s  ON s.id  = ss.service_id  AND s.tenant_id  = ss.tenant_id
       LEFT JOIN resources r  ON r.id  = ss.resource_id AND r.tenant_id  = ss.tenant_id
       LEFT JOIN staff     st ON st.id = ss.staff_id    AND st.tenant_id = ss.tenant_id
       WHERE ss.id = $1 AND ss.tenant_id = $2
       LIMIT 1`,
      [sessionId, tenantId]
    );

    if (!sessionRes.rows.length) {
      return res.status(404).json({ error: "Session not found." });
    }

    const participantsRes = await db.query(
      `SELECT
         b.id,
         b.booking_code,
         b.customer_name,
         b.customer_phone,
         b.customer_email,
         b.status,
         b.start_time,
         b.duration_minutes,
         b.price_amount,
         b.charge_amount,
         b.currency_code,
         b.created_at
       FROM bookings b
       WHERE b.session_id = $1
         AND b.deleted_at IS NULL
       ORDER BY b.created_at ASC`,
      [sessionId]
    );

    return res.json({
      session: sessionRes.rows[0],
      participants: participantsRes.rows,
    });
  } catch (err) {
    console.error("sessions GET detail error:", err);
    return res.status(500).json({ error: "Failed to load session." });
  }
});

// ─── POST /api/tenant/:slug/sessions/:id/cancel ───────────────────────────────
// Cancel the session and all its active bookings.
router.post(
  "/:slug/sessions/:id/cancel",
  requireAppAuth,
  injectTenantSlug,
  requireTenant,
  requireAdminOrTenantRole("owner"),
  async (req, res) => {
    try {
      const tenantId  = req.tenantId;
      const sessionId = Number(req.params.id);

      if (!Number.isFinite(sessionId) || sessionId <= 0) {
        return res.status(400).json({ error: "Invalid session id." });
      }

      const sessionRes = await db.query(
        `SELECT id, status FROM service_sessions WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [sessionId, tenantId]
      );

      if (!sessionRes.rows.length) {
        return res.status(404).json({ error: "Session not found." });
      }
      if (sessionRes.rows[0].status === "cancelled") {
        return res.status(409).json({ error: "Session is already cancelled." });
      }

      const client = await db.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `UPDATE bookings
           SET status = 'cancelled'
           WHERE session_id = $1
             AND status IN ('pending', 'confirmed')
             AND deleted_at IS NULL`,
          [sessionId]
        );

        await client.query(
          `UPDATE service_sessions
           SET status = 'cancelled', confirmed_count = 0
           WHERE id = $1`,
          [sessionId]
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return res.json({ success: true, sessionId });
    } catch (err) {
      console.error("sessions cancel error:", err);
      return res.status(500).json({ error: "Failed to cancel session." });
    }
  }
);

module.exports = router;
