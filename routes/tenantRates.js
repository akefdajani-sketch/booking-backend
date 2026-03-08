// routes/tenantRates.js
// Dynamic pricing rules (Rates) for a tenant.
//
// Endpoints:
//   GET    /api/tenant/:slug/rates
//   POST   /api/tenant/:slug/rates
//   PATCH  /api/tenant/:slug/rates/:id
//   DELETE /api/tenant/:slug/rates/:id
//   POST   /api/tenant/:slug/rates/preview
//
// Auth:
//   requireGoogleAuth + ensureUser + requireTenant + requireTenantRole(['owner','manager'])

const express = require("express");

const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const ensureUser = require("../middleware/ensureUser");
const { requireTenant } = require("../middleware/requireTenant");
const { requireTenantRole } = require("../middleware/requireTenantRole");
const { pool } = require("../db");
const db = pool;

const { computeRateForBookingLike } = require("../utils/ratesEngine");

const router = express.Router();

function injectTenantSlug(req, _res, next) {
  req.query = req.query || {};
  req.query.tenantSlug = req.params.slug;
  next();
}

function toInt(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function toNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function normalizePriceType(v) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "fixed" || s === "delta" || s === "multiplier") return s;
  return null;
}

function normalizeDowArray(v) {
  // Accept: [0..6] array, or "0,1,2".
  if (v == null || v === "") return null;
  const arr = Array.isArray(v)
    ? v
    : String(v)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
  const out = [];
  for (const x of arr) {
    const n = Number(x);
    if (!Number.isFinite(n)) continue;
    const nn = Math.trunc(n);
    if (nn < 0 || nn > 6) continue;
    out.push(nn);
  }
  return out.length ? Array.from(new Set(out)).sort((a, b) => a - b) : null;
}

function normalizeTime(v) {
  // "HH:MM" or "HH:MM:SS".
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  return s.length === 5 ? `${s}:00` : s;
}

function normalizeDate(v) {
  // "YYYY-MM-DD"
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// GET list
// ---------------------------------------------------------------------------
router.get(
  "/:slug/rates",
  requireGoogleAuth,
  ensureUser,
  injectTenantSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const includeInactive = String(req.query.includeInactive || "") === "1";

      const where = [`tenant_id = $1`];
      const params = [tenantId];
      if (!includeInactive) where.push(`COALESCE(is_active,true)=true`);

      const sql = `
        SELECT
          id, name, is_active,
          service_id, staff_id, resource_id,
          currency_code, price_type, amount,
          days_of_week, time_start, time_end,
          date_start, date_end,
          min_duration_mins, max_duration_mins,
          priority,
          COALESCE(metadata, '{}'::jsonb) AS metadata,
          created_at, updated_at
        FROM rate_rules
        WHERE ${where.join(" AND ")}
        ORDER BY priority DESC, id DESC
      `;
      const { rows } = await db.query(sql, params);
      return res.json({ items: rows });
    } catch (err) {
      console.error("GET tenant rates error:", err);
      return res.status(500).json({ error: "Failed to load rates." });
    }
  }
);

// ---------------------------------------------------------------------------
// POST create
// ---------------------------------------------------------------------------
router.post(
  "/:slug/rates",
  requireGoogleAuth,
  ensureUser,
  injectTenantSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const name = String(req.body?.name || "").trim();
      const is_active = req.body?.is_active === undefined ? true : Boolean(req.body?.is_active);

      const service_id = toInt(req.body?.service_id);
      const staff_id = toInt(req.body?.staff_id);
      const resource_id = toInt(req.body?.resource_id);
      const currency_code = String(req.body?.currency_code || "").trim() || null;

      const price_type = normalizePriceType(req.body?.price_type);
      const amount = toNum(req.body?.amount);
      const days_of_week = normalizeDowArray(req.body?.days_of_week);
      const time_start = normalizeTime(req.body?.time_start);
      const time_end = normalizeTime(req.body?.time_end);
      const date_start = normalizeDate(req.body?.date_start);
      const date_end = normalizeDate(req.body?.date_end);
      const min_duration_mins = toInt(req.body?.min_duration_mins);
      const max_duration_mins = toInt(req.body?.max_duration_mins);
      const priority = toInt(req.body?.priority) ?? 100;
      const metadata = req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};

      if (!name) return res.status(400).json({ error: "Name is required." });
      if (!service_id && !staff_id && !resource_id) {
        return res.status(400).json({ error: "At least one scope field is required (service/staff/resource)." });
      }
      if (!price_type) return res.status(400).json({ error: "Invalid price_type." });
      if (amount == null) return res.status(400).json({ error: "Amount is required." });

      const insert = await db.query(
        `
        INSERT INTO rate_rules (
          tenant_id, name, is_active,
          service_id, staff_id, resource_id,
          currency_code, price_type, amount,
          days_of_week, time_start, time_end,
          date_start, date_end,
          min_duration_mins, max_duration_mins,
          priority, metadata
        )
        VALUES (
          $1,$2,$3,
          $4,$5,$6,
          $7,$8,$9,
          $10,$11,$12,
          $13,$14,
          $15,$16,
          $17,$18
        )
        RETURNING *
        `,
        [
          tenantId,
          name,
          is_active,
          service_id,
          staff_id,
          resource_id,
          currency_code,
          price_type,
          amount,
          days_of_week,
          time_start,
          time_end,
          date_start,
          date_end,
          min_duration_mins,
          max_duration_mins,
          priority,
          metadata,
        ]
      );
      return res.json({ item: insert.rows[0] });
    } catch (err) {
      console.error("POST tenant rates error:", err);
      return res.status(500).json({ error: "Failed to create rate rule." });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH update
// ---------------------------------------------------------------------------
router.patch(
  "/:slug/rates/:id",
  requireGoogleAuth,
  ensureUser,
  injectTenantSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id." });

      const patch = {};

      if (req.body?.name !== undefined) patch.name = String(req.body.name || "").trim();
      if (req.body?.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
      if (req.body?.service_id !== undefined) patch.service_id = toInt(req.body.service_id);
      if (req.body?.staff_id !== undefined) patch.staff_id = toInt(req.body.staff_id);
      if (req.body?.resource_id !== undefined) patch.resource_id = toInt(req.body.resource_id);
      if (req.body?.currency_code !== undefined) patch.currency_code = String(req.body.currency_code || "").trim() || null;
      if (req.body?.price_type !== undefined) patch.price_type = normalizePriceType(req.body.price_type);
      if (req.body?.amount !== undefined) patch.amount = toNum(req.body.amount);
      if (req.body?.days_of_week !== undefined) patch.days_of_week = normalizeDowArray(req.body.days_of_week);
      if (req.body?.time_start !== undefined) patch.time_start = normalizeTime(req.body.time_start);
      if (req.body?.time_end !== undefined) patch.time_end = normalizeTime(req.body.time_end);
      if (req.body?.date_start !== undefined) patch.date_start = normalizeDate(req.body.date_start);
      if (req.body?.date_end !== undefined) patch.date_end = normalizeDate(req.body.date_end);
      if (req.body?.min_duration_mins !== undefined) patch.min_duration_mins = toInt(req.body.min_duration_mins);
      if (req.body?.max_duration_mins !== undefined) patch.max_duration_mins = toInt(req.body.max_duration_mins);
      if (req.body?.priority !== undefined) patch.priority = toInt(req.body.priority);
      if (req.body?.metadata !== undefined) patch.metadata = req.body.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};

      if (patch.price_type === null) return res.status(400).json({ error: "Invalid price_type." });

      const keys = Object.keys(patch);
      if (!keys.length) return res.status(400).json({ error: "No fields to update." });

      // Ensure rule belongs to tenant
      const existing = await db.query(`SELECT id FROM rate_rules WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
      if (!existing.rows.length) return res.status(404).json({ error: "Not found." });

      const sets = [];
      const params = [tenantId, id];
      let idx = 2;
      for (const k of keys) {
        idx += 1;
        sets.push(`${k} = $${idx}`);
        params.push(patch[k]);
      }
      const sql = `
        UPDATE rate_rules
        SET ${sets.join(", ")}, updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *
      `;
      const { rows } = await db.query(sql, params);
      return res.json({ item: rows[0] });
    } catch (err) {
      console.error("PATCH tenant rates error:", err);
      return res.status(500).json({ error: "Failed to update rate rule." });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
router.delete(
  "/:slug/rates/:id",
  requireGoogleAuth,
  ensureUser,
  injectTenantSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id." });

      const del = await db.query(`DELETE FROM rate_rules WHERE tenant_id=$1 AND id=$2 RETURNING id`, [tenantId, id]);
      if (!del.rows.length) return res.status(404).json({ error: "Not found." });
      return res.json({ ok: true });
    } catch (err) {
      console.error("DELETE tenant rates error:", err);
      return res.status(500).json({ error: "Failed to delete rate rule." });
    }
  }
);

// ---------------------------------------------------------------------------
// POST preview (compute)
// ---------------------------------------------------------------------------
router.post(
  "/:slug/rates/preview",
  requireGoogleAuth,
  ensureUser,
  injectTenantSlug,
  requireTenant,
  requireTenantRole(["owner", "manager"]),
  async (req, res) => {
    try {
      const tenantId = Number(req.tenantId);

      const service_id = toInt(req.body?.service_id);
      const staff_id = toInt(req.body?.staff_id);
      const resource_id = toInt(req.body?.resource_id);
      const start_time = String(req.body?.start_time || "").trim();
      const duration_minutes = toInt(req.body?.duration_minutes);
      const base_price_amount = toNum(req.body?.base_price_amount);

      if (!service_id) return res.status(400).json({ error: "service_id is required" });
      if (!start_time) return res.status(400).json({ error: "start_time is required" });
      if (!duration_minutes || duration_minutes <= 0) return res.status(400).json({ error: "duration_minutes is required" });

      const start = new Date(start_time);
      if (!Number.isFinite(start.getTime())) return res.status(400).json({ error: "Invalid start_time" });

      const payload = await computeRateForBookingLike({
        tenantId,
        serviceId: service_id,
        staffId: staff_id,
        resourceId: resource_id,
        start,
        durationMinutes: duration_minutes,
        basePriceAmount: base_price_amount,
      });

      return res.json(payload);
    } catch (err) {
      console.error("POST tenant rates preview error:", err);
      return res.status(500).json({ error: "Failed to preview rate." });
    }
  }
);

module.exports = router;
