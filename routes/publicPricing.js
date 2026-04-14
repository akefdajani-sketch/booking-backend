// routes/publicPricing.js
// Public pricing quote endpoint for the booking UI.
//
// Endpoints:
//   POST /api/public/:slug/pricing/quote   — price + tax breakdown for a booking
//   GET  /api/public/:slug/packages        — active prepaid products catalog
//
// PR-TAX-1 changes:
//   - After computing rate-rule price, run computeTaxForBooking() from taxEngine.
//   - Response now includes full tax breakdown (subtotal, vat, service_charge, total).
//   - Backward-compatible: tax fields are simply 0/null if tenant has no tax config.

const express = require("express");

const { requireTenant } = require("../middleware/requireTenant");
const { pool } = require("../db");
const db = pool;
const { computeRateForBookingLike } = require("../utils/ratesEngine");
const {
  computeTaxForBooking,
  buildPublicTaxSummary,
  loadTenantTaxConfig,
} = require("../utils/taxEngine");

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

    // Load service base price + duration for proportional scaling.
    // Dynamically detect which price column exists to support both schema versions.
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

    // ── Apply rate rules (non-fatal if rate_rules table missing) ──────────────
    let computed = {
      base_price_amount: basePriceAmount,
      adjusted_price_amount: basePriceAmount,
      applied_rate_rule_id: null,
      applied_rate_snapshot: null,
    };

    try {
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

      if (computed.adjusted_price_amount == null) {
        computed.adjusted_price_amount = basePriceAmount;
      }
    } catch (e) {
      console.warn("ratesEngine non-fatal error (pricing quote):", e?.message || e);
    }

    // ── Resolve currency ──────────────────────────────────────────────────────
    const tcur = await db.query(`SELECT currency_code FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
    const currency_code =
      computed?.applied_rate_snapshot?.rule?.currency_code ||
      tcur.rows?.[0]?.currency_code ||
      "JD";

    // ── PR-TAX-1: Compute tax breakdown ───────────────────────────────────────
    // chargedAmount is the post-rate-rule price. Tax is applied on top of (or
    // extracted from, if inclusive) this amount.
    const chargedAmount = computed.adjusted_price_amount;
    let taxResult = null;

    if (chargedAmount != null && Number.isFinite(chargedAmount) && chargedAmount > 0) {
      try {
        taxResult = await computeTaxForBooking({
          tenantId,
          serviceId,
          chargedAmount,
        });
      } catch (taxErr) {
        // Non-fatal: if tax engine fails, return the base price without tax breakdown
        console.warn("taxEngine non-fatal error (pricing quote):", taxErr?.message || taxErr);
      }
    }

    // Build tax summary for the UI — or return zero-value defaults
    const taxSummary = taxResult
      ? buildPublicTaxSummary({ breakdown: taxResult, effective: taxResult.effective, currencyCode: currency_code })
      : {
          subtotal:                chargedAmount,
          vat_amount:              0,
          vat_label:               "VAT",
          vat_rate:                0,
          service_charge_amount:   0,
          service_charge_label:    "Service Charge",
          service_charge_rate:     0,
          total:                   chargedAmount,
          tax_inclusive:           false,
          show_breakdown:          false,
          currency_code,
        };

    return res.json({
      // ── Original fields (backward-compatible) ────────────────────────────
      base_price_amount:     computed.base_price_amount,
      adjusted_price_amount: computed.adjusted_price_amount,
      currency_code,
      applied_rate_rule_id:  computed.applied_rate_rule_id,
      applied_rate_snapshot: computed.applied_rate_snapshot,

      // ── PR-TAX-1: Tax breakdown ───────────────────────────────────────────
      tax: taxSummary,
    });
  } catch (err) {
    console.error("Public pricing quote error:", err);
    return res.status(500).json({ error: "Failed to compute quote." });
  }
});


// ---------------------------------------------------------------------------
// Public Packages Catalog (Prepaid Products)
// GET /api/public/:slug/packages
// Returns active prepaid products that are customer-visible.
// ---------------------------------------------------------------------------
router.get("/:slug/packages", injectTenantSlug, requireTenant, async (req, res) => {
  try {
    const tenantId = Number(req.tenantId);
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });

    const schemaCheck = await db.query(
      `SELECT to_regclass('public.prepaid_products') AS prod`
    );
    const ready = !!schemaCheck.rows?.[0]?.prod;
    if (!ready) return res.json({ items: [] });

    // customer_visible is optional across schema versions; if absent, treat as visible.
    const colsRes = await db.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='prepaid_products'`
    );
    const cols = new Set(colsRes.rows.map((r) => r.column_name));
    const visCol = cols.has("customer_visible")
      ? "customer_visible"
      : cols.has("is_customer_visible")
        ? "is_customer_visible"
        : null;

    const visClause = visCol ? `AND COALESCE(${visCol}, true) = true` : "";

    const q = await db.query(
      `
      SELECT
        id,
        tenant_id,
        name,
        description,
        product_type,
        price,
        currency,
        validity_unit,
        validity_value,
        credit_amount,
        session_count,
        minutes_total,
        eligible_service_ids,
        rules,
        is_active
        ${visCol ? `, ${visCol} AS customer_visible` : ""}
      FROM prepaid_products
      WHERE tenant_id=$1
        AND COALESCE(is_active, true)=true
        ${visClause}
      ORDER BY updated_at DESC, id DESC
      `,
      [tenantId]
    );

    const items = q.rows.map((p) => {
      const unit_type =
        Number(p?.minutes_total ?? 0) > 0
          ? "minute"
          : Number(p?.credit_amount ?? 0) > 0
            ? "credit"
            : "package_use";
      const included_quantity =
        Number(p?.minutes_total ?? 0) > 0
          ? Number(p.minutes_total)
          : Number(p?.credit_amount ?? 0) > 0
            ? Number(p.credit_amount)
            : Number(p?.session_count ?? 0) > 0
              ? Number(p.session_count)
              : 1;

      const validity_days =
        String(p?.validity_unit || "").toLowerCase() === "days"
          ? Number(p?.validity_value ?? 0) || 0
          : String(p?.validity_unit || "").toLowerCase() === "weeks"
            ? (Number(p?.validity_value ?? 0) || 0) * 7
            : String(p?.validity_unit || "").toLowerCase() === "months"
              ? (Number(p?.validity_value ?? 0) || 0) * 30
              : null;

      return {
        id: p.id,
        tenant_id: p.tenant_id,
        name: p.name,
        description: p.description ?? null,
        product_type: p.product_type || "service_package",
        unit_type,
        price_amount: p.price == null ? null : Number(p.price),
        currency: p.currency ?? null,
        validity_days,
        included_quantity,
        eligible_service_ids: Array.isArray(p.eligible_service_ids) ? p.eligible_service_ids : [],
        active: !!p.is_active,
        customer_visible: visCol ? !!p.customer_visible : true,
      };
    });

    return res.json({ items });
  } catch (err) {
    console.error("GET /public/:slug/packages error:", err);
    return res.status(500).json({ error: "Failed to load packages." });
  }
});

module.exports = router;
