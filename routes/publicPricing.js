// routes/publicPricing.js
// Public pricing quote endpoint for the booking UI.
//
// Endpoint:
//   POST /api/public/:slug/pricing/quote
//
// Notes:
// - Public-safe: returns ONLY computed pricing output (no rate rule list)
// - Tenant resolved server-side (slug -> tenantId)
// - Server computes base service price and scales for duration, then applies rate rules.

const express = require("express");

const { requireTenant } = require("../middleware/requireTenant");
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

router.post("/:slug/pricing/quote", injectTenantSlug, requireTenant, async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);

    const serviceId = toInt(req.body?.serviceId);
    const staffId = toInt(req.body?.staffId);
    const resourceId = toInt(req.body?.resourceId);
    const durationMinutes = toInt(req.body?.duration_minutes ?? req.body?.durationMinutes);
    const startRaw = String(req.body?.start_time ?? req.body?.startTimeISO ?? "").trim();

    if (!tenantId) return res.status(400).json({ error: "Missing tenant context." });
    if (!serviceId) return res.status(400).json({ error: "Missing serviceId." });
    if (!durationMinutes || durationMinutes < 1) {
      return res.status(400).json({ error: "Missing duration_minutes." });
    }
    if (!startRaw) return res.status(400).json({ error: "Missing start_time." });

    const start = new Date(startRaw);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid start_time." });
    }

    // Load service base price + duration for proportional scaling (match booking create behavior).
    // Dynamically detect which price column exists to support both schema versions:
    //   - Newer schemas: price_amount (NUMERIC)
    //   - Older schemas: price (NUMERIC)
    // This mirrors the same pattern used in routes/services.js and routes/bookings.js.
    const priceCols = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'services'
         AND column_name  IN ('price_amount','price')`,
      []
    );
    const hasPriceAmount = priceCols.rows.some((r) => r.column_name === "price_amount");
    const hasPriceLegacy = priceCols.rows.some((r) => r.column_name === "price");
    const priceExpr =
      hasPriceAmount && hasPriceLegacy
        ? "COALESCE(s.price_amount, s.price) AS price_amount"
        : hasPriceAmount
        ? "s.price_amount AS price_amount"
        : hasPriceLegacy
        ? "s.price AS price_amount"
        : "NULL::numeric AS price_amount";

    const svc = await db.query(
      `
      SELECT
        s.id,
        s.duration_minutes,
        COALESCE(s.slot_interval_minutes, s.duration_minutes) AS slot_interval_minutes,
        ${priceExpr}
      FROM services s
      WHERE s.tenant_id = $1 AND s.id = $2
      LIMIT 1
      `,
      [tenantId, serviceId]
    );

    if (!svc.rows.length) return res.status(404).json({ error: "Service not found." });

    const servicePriceAmount = toNum(svc.rows[0].price_amount);
    const serviceDurationMinutes = toInt(svc.rows[0].duration_minutes);
    const serviceSlotMinutes      = toInt(svc.rows[0].slot_interval_minutes) || serviceDurationMinutes;

    let basePriceAmount = null;
    if (servicePriceAmount != null && Number.isFinite(servicePriceAmount)) {
      const base = Number(servicePriceAmount);
      const svcDur = Number(serviceDurationMinutes || durationMinutes || 0);
      const dur = Number(durationMinutes || 0);
      if (svcDur > 0 && dur > 0 && dur !== svcDur) {
        basePriceAmount = Math.round(base * (dur / svcDur) * 100) / 100;
      } else {
        basePriceAmount = Math.round(base * 100) / 100;
      }
    }

    // Apply Rates rules (non-fatal if rate_rules missing)
    let computed = {
      base_price_amount: basePriceAmount,
      adjusted_price_amount: basePriceAmount,
      applied_rate_rule_id: null,
      applied_rate_snapshot: null,
    };

    try {
      if (basePriceAmount != null && Number.isFinite(Number(basePriceAmount))) {
        computed = await computeRateForBookingLike({
          tenantId,
          serviceId,
          staffId,
          resourceId,
          start,
          durationMinutes,
          basePriceAmount,
          serviceSlotMinutes,
        });
      }
    } catch (e) {
      // Keep endpoint resilient; UI can still show base price.
      console.warn("ratesEngine non-fatal error (pricing quote):", e?.message || e);
    }

    // Prefer tenant currency if service/rule doesn't define it.
    const tcur = await db.query(`SELECT currency_code FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
    const currency_code =
      computed?.applied_rate_snapshot?.rule?.currency_code ||
      tcur.rows?.[0]?.currency_code ||
      "JD";

    return res.json({
      base_price_amount: computed.base_price_amount,
      adjusted_price_amount: computed.adjusted_price_amount,
      currency_code,
      applied_rate_rule_id: computed.applied_rate_rule_id,
      applied_rate_snapshot: computed.applied_rate_snapshot,
    });
  } catch (err) {
    console.error("Public pricing quote error:", err);
    return res.status(500).json({ error: "Failed to compute quote." });
  }
});

module.exports = router;
