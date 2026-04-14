// utils/taxEngine.js
// PR-TAX-1: Core tax computation engine.
//
// Used by:
//   - routes/publicPricing.js  (quote endpoint)
//   - routes/bookings/create.js (booking creation)
//   - routes/tenantTax.js       (admin settings)
//
// Design principles:
//   1. Pure functions where possible – easy to test.
//   2. All amounts returned as JS Numbers rounded to 3 decimal places
//      (enough for JOD fils, GBP pence, USD cents, etc.).
//   3. Zero-rate safety: if both vat_rate and service_charge_rate are 0 / null,
//      the function returns clean zero values without dividing by zero.
//   4. Inclusive/exclusive handled here once – callers never need to know.

'use strict';

const { pool } = require('../db');
const db = pool;

// ─── Default config shape ─────────────────────────────────────────────────────

const DEFAULT_TAX_CONFIG = {
  vat_rate:                0,
  vat_label:               'VAT',
  service_charge_rate:     0,
  service_charge_label:    'Service Charge',
  tax_inclusive:           false,
  show_tax_breakdown:      true,
  tax_registration_number: null,
};

// ─── Database helpers ─────────────────────────────────────────────────────────

/**
 * Load the tenant-level tax config. Always returns a fully-merged object
 * with defaults filling any missing keys. Never throws.
 */
async function loadTenantTaxConfig(tenantId) {
  try {
    const r = await db.query(
      `SELECT tax_config FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const stored = r.rows?.[0]?.tax_config;
    return mergeTaxConfig(stored);
  } catch (_e) {
    return { ...DEFAULT_TAX_CONFIG };
  }
}

/**
 * Load the per-service VAT override fields (vat_rate, vat_label, service_charge_rate).
 * Returns null if service not found or columns don't exist yet.
 */
async function loadServiceTaxOverride(tenantId, serviceId) {
  try {
    // Guard: columns may not exist on very old schemas (pre-migration 030).
    const colsRes = await db.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'services'
          AND column_name  IN ('vat_rate', 'vat_label', 'service_charge_rate')`,
      []
    );
    const cols = new Set(colsRes.rows.map((r) => r.column_name));
    if (!cols.has('vat_rate')) return null;

    const selectParts = ['id'];
    if (cols.has('vat_rate'))           selectParts.push('vat_rate');
    if (cols.has('vat_label'))          selectParts.push('vat_label');
    if (cols.has('service_charge_rate')) selectParts.push('service_charge_rate');

    const r = await db.query(
      `SELECT ${selectParts.join(', ')} FROM services
        WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, serviceId]
    );
    return r.rows?.[0] || null;
  } catch (_e) {
    return null;
  }
}

/**
 * Save tenant tax config. Merges with existing config (patch semantics).
 */
async function saveTenantTaxConfig(tenantId, updates) {
  // Validate inputs
  const validated = sanitizeTaxConfigInput(updates);

  // Check column exists (guard for old schemas).
  const colRes = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenants' AND column_name='tax_config'`,
    []
  );
  if (!colRes.rows.length) {
    throw new Error('tax_config column not found. Run migration 030 first.');
  }

  // Load current config to patch it (not overwrite unrelated keys).
  const current = await loadTenantTaxConfig(tenantId);
  const merged = { ...current, ...validated };

  await db.query(
    `UPDATE tenants SET tax_config = $1 WHERE id = $2`,
    [JSON.stringify(merged), tenantId]
  );
  return merged;
}

// ─── Config merging ────────────────────────────────────────────────────────────

function mergeTaxConfig(stored) {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_TAX_CONFIG };
  return {
    vat_rate:                toSafeRate(stored.vat_rate)             ?? DEFAULT_TAX_CONFIG.vat_rate,
    vat_label:               typeof stored.vat_label === 'string'    ? stored.vat_label.trim() : DEFAULT_TAX_CONFIG.vat_label,
    service_charge_rate:     toSafeRate(stored.service_charge_rate)  ?? DEFAULT_TAX_CONFIG.service_charge_rate,
    service_charge_label:    typeof stored.service_charge_label === 'string' ? stored.service_charge_label.trim() : DEFAULT_TAX_CONFIG.service_charge_label,
    tax_inclusive:           typeof stored.tax_inclusive === 'boolean' ? stored.tax_inclusive : DEFAULT_TAX_CONFIG.tax_inclusive,
    show_tax_breakdown:      typeof stored.show_tax_breakdown === 'boolean' ? stored.show_tax_breakdown : DEFAULT_TAX_CONFIG.show_tax_breakdown,
    tax_registration_number: typeof stored.tax_registration_number === 'string' ? stored.tax_registration_number.trim() || null : null,
  };
}

function sanitizeTaxConfigInput(input) {
  const out = {};
  if (input.vat_rate              !== undefined) out.vat_rate              = toSafeRate(input.vat_rate) ?? 0;
  if (input.vat_label             !== undefined) out.vat_label             = String(input.vat_label || 'VAT').trim().slice(0, 50);
  if (input.service_charge_rate   !== undefined) out.service_charge_rate   = toSafeRate(input.service_charge_rate) ?? 0;
  if (input.service_charge_label  !== undefined) out.service_charge_label  = String(input.service_charge_label || 'Service Charge').trim().slice(0, 50);
  if (input.tax_inclusive         !== undefined) out.tax_inclusive         = !!input.tax_inclusive;
  if (input.show_tax_breakdown    !== undefined) out.show_tax_breakdown    = !!input.show_tax_breakdown;
  if (input.tax_registration_number !== undefined) out.tax_registration_number = String(input.tax_registration_number || '').trim().slice(0, 100) || null;
  return out;
}

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * Resolve the effective VAT and service charge rates for a specific booking,
 * merging per-service overrides on top of tenant defaults.
 *
 * @param {object} serviceOverride  – row from loadServiceTaxOverride (may be null)
 * @param {object} tenantTaxConfig  – merged config from loadTenantTaxConfig
 * @returns {{ vatRate, serviceChargeRate, vatLabel, serviceChargeLabel, taxInclusive, showBreakdown }}
 */
function resolveEffectiveTaxRates(serviceOverride, tenantTaxConfig) {
  const vatRate = (serviceOverride?.vat_rate            != null)
    ? toSafeRate(serviceOverride.vat_rate)   ?? tenantTaxConfig.vat_rate
    : tenantTaxConfig.vat_rate;

  const serviceChargeRate = (serviceOverride?.service_charge_rate != null)
    ? toSafeRate(serviceOverride.service_charge_rate) ?? tenantTaxConfig.service_charge_rate
    : tenantTaxConfig.service_charge_rate;

  const vatLabel = (serviceOverride?.vat_label && typeof serviceOverride.vat_label === 'string')
    ? serviceOverride.vat_label.trim()
    : tenantTaxConfig.vat_label;

  return {
    vatRate:           vatRate           ?? 0,
    serviceChargeRate: serviceChargeRate ?? 0,
    vatLabel:          vatLabel          || 'VAT',
    serviceChargeLabel: tenantTaxConfig.service_charge_label || 'Service Charge',
    taxInclusive:      !!tenantTaxConfig.tax_inclusive,
    showBreakdown:     !!tenantTaxConfig.show_tax_breakdown,
  };
}

/**
 * Compute the full tax breakdown for a given price amount.
 *
 * Inclusive mode (tax_inclusive = true):
 *   The passed-in price ALREADY contains tax. We back-calculate the subtotal.
 *   subtotal = price / (1 + (vatRate + serviceChargeRate) / 100)
 *   Total remains equal to the original price.
 *
 * Exclusive mode (tax_inclusive = false):
 *   Price is the pre-tax amount. Tax is added on top.
 *   total = price + vat + service_charge
 *
 * @param {object} params
 * @param {number} params.baseAmount         – the charged price (before or incl. tax)
 * @param {number} params.vatRate            – percent, e.g. 16
 * @param {number} params.serviceChargeRate  – percent, e.g. 5
 * @param {boolean} params.taxInclusive
 * @returns {{ subtotal, vat_amount, service_charge_amount, total }}
 */
function computeTaxBreakdown({ baseAmount, vatRate, serviceChargeRate, taxInclusive }) {
  const amount = Number(baseAmount) || 0;
  const vr     = Number(vatRate)            || 0;
  const scr    = Number(serviceChargeRate)  || 0;

  if (vr === 0 && scr === 0) {
    return {
      subtotal:               r(amount),
      vat_amount:             0,
      service_charge_amount:  0,
      total:                  r(amount),
    };
  }

  let subtotal;
  if (taxInclusive) {
    // Back-calculate: price already contains all tax
    subtotal = amount / (1 + (vr + scr) / 100);
  } else {
    subtotal = amount;
  }

  const vat_amount            = r(subtotal * (vr  / 100));
  const service_charge_amount = r(subtotal * (scr / 100));
  const total                 = r(subtotal + vat_amount + service_charge_amount);

  return {
    subtotal:               r(subtotal),
    vat_amount,
    service_charge_amount,
    total,
  };
}

/**
 * Full pipeline: load config, resolve rates, compute breakdown.
 * Returns everything needed to store on the booking and show in the UI.
 *
 * @param {object} params
 * @param {number} params.tenantId
 * @param {number} params.serviceId          (optional – for per-service override)
 * @param {number} params.chargedAmount      – the price being charged (post rate-rule)
 * @returns {object} full tax result including snapshot
 */
async function computeTaxForBooking({ tenantId, serviceId, chargedAmount }) {
  const tenantTaxConfig  = await loadTenantTaxConfig(tenantId);
  const serviceOverride  = serviceId ? await loadServiceTaxOverride(tenantId, serviceId) : null;
  const effective        = resolveEffectiveTaxRates(serviceOverride, tenantTaxConfig);

  const breakdown = computeTaxBreakdown({
    baseAmount:         chargedAmount,
    vatRate:            effective.vatRate,
    serviceChargeRate:  effective.serviceChargeRate,
    taxInclusive:       effective.taxInclusive,
  });

  // Build an immutable snapshot to store alongside the booking.
  const snapshot = {
    vat_rate:               effective.vatRate,
    vat_label:              effective.vatLabel,
    service_charge_rate:    effective.serviceChargeRate,
    service_charge_label:   effective.serviceChargeLabel,
    tax_inclusive:          effective.taxInclusive,
    per_service_override:   serviceOverride
      ? {
          vat_rate:           serviceOverride.vat_rate            ?? null,
          service_charge_rate: serviceOverride.service_charge_rate ?? null,
        }
      : null,
    computed_at: new Date().toISOString(),
  };

  return {
    ...breakdown,
    effective,
    snapshot,
    // Convenience: show breakdown only if any tax exists and config says to
    show_breakdown: effective.showBreakdown && (effective.vatRate > 0 || effective.serviceChargeRate > 0),
  };
}

/**
 * Build the public-safe tax summary to return from the pricing quote endpoint.
 * Never exposes internal config details beyond what the booking UI needs.
 */
function buildPublicTaxSummary({ breakdown, effective, currencyCode }) {
  return {
    subtotal:                breakdown.subtotal,
    vat_amount:              breakdown.vat_amount,
    vat_label:               effective.vatLabel,
    vat_rate:                effective.vatRate,
    service_charge_amount:   breakdown.service_charge_amount,
    service_charge_label:    effective.serviceChargeLabel,
    service_charge_rate:     effective.serviceChargeRate,
    total:                   breakdown.total,
    tax_inclusive:           effective.taxInclusive,
    show_breakdown:          effective.showBreakdown && (effective.vatRate > 0 || effective.serviceChargeRate > 0),
    currency_code:           currencyCode || 'JD',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Round to 3 decimal places. */
function r(n) { return Math.round(Number(n) * 1000) / 1000; }

/** Convert a value to a safe non-negative rate, or null if invalid. */
function toSafeRate(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 100) return null; // sanity cap: no rate above 100%
  return n;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  loadTenantTaxConfig,
  loadServiceTaxOverride,
  saveTenantTaxConfig,
  resolveEffectiveTaxRates,
  computeTaxBreakdown,
  computeTaxForBooking,
  buildPublicTaxSummary,
  mergeTaxConfig,
  DEFAULT_TAX_CONFIG,
};
