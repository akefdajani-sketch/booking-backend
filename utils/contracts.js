'use strict';

// utils/contracts.js
// G2a-1: Long-term contracts — core helpers.
//
// Responsibilities:
//   - generateContractNumber()   — per-tenant advisory-locked sequence
//   - resolveContractPrefix()    — read tenants.contract_number_prefix or fall back
//   - deriveStayType()           — nightly | long_stay | contract_stay from booking data
//   - applyTemplate()            — explode milestones into concrete invoice rows
//   - computeMilestoneDueDate()  — trigger-specific date calculation
//   - insertContractInvoices()   — bulk-insert contract_invoices rows inside a tx
//
// All money is NUMERIC(12,3) — we round to 0.001 precision.

const logger = require('./logger');

// ---------------------------------------------------------------------------
// Rounding — NUMERIC(12,3) = 3 decimal places
// ---------------------------------------------------------------------------

const MINOR_UNIT = 1000; // 3-decimal precision

function roundMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * MINOR_UNIT) / MINOR_UNIT;
}

// ---------------------------------------------------------------------------
// Tenant prefix resolution
// ---------------------------------------------------------------------------

/**
 * Returns the prefix used in contract numbers for this tenant.
 * Falls back to UPPER(LEFT(slug, 3)) if tenants.contract_number_prefix is NULL.
 * Always returns a valid prefix (2-10 chars, [A-Z0-9]).
 */
function resolveContractPrefix(tenant) {
  if (!tenant) throw new Error('resolveContractPrefix: tenant required');

  const stored = (tenant.contract_number_prefix || '').toString().trim();
  if (stored && /^[A-Z0-9]+$/.test(stored) && stored.length >= 2 && stored.length <= 10) {
    return stored;
  }

  const slug = (tenant.slug || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fallback = slug.slice(0, 3) || 'TEN';
  return fallback.length >= 2 ? fallback : (fallback + 'X'); // pad to min 2 chars
}

// ---------------------------------------------------------------------------
// Contract number generation
// ---------------------------------------------------------------------------

/**
 * Generate the next contract number for a tenant + year.
 * MUST be called inside a transaction (takes a `client`, not the pool).
 * Uses pg_advisory_xact_lock on tenant_id to serialize concurrent creations.
 *
 * Format: {PREFIX}-CON-{YYYY}-{SEQ:04d}, e.g. "AQB-CON-2026-0001".
 *
 * The sequence resets per (tenant, year). If more than 9999 contracts in one
 * year for one tenant, falls back to 5+ digits without padding (unlikely).
 */
async function generateContractNumber(client, { tenantId, tenantPrefix, year }) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('generateContractNumber: client required (must be inside a transaction)');
  }
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    throw new Error('generateContractNumber: tenantId required');
  }
  const prefix = (tenantPrefix || '').toString().trim();
  if (!/^[A-Z0-9]{2,10}$/.test(prefix)) {
    throw new Error(`generateContractNumber: invalid prefix "${prefix}"`);
  }
  const y = Number(year) || new Date().getUTCFullYear();

  // Serialize concurrent generations for this tenant within the current tx.
  // Releases automatically on COMMIT/ROLLBACK.
  await client.query('SELECT pg_advisory_xact_lock($1)', [tenantId]);

  const likePattern = `${prefix}-CON-${y}-%`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(
       CAST(SUBSTRING(contract_number FROM '[0-9]+$') AS INTEGER)
     ), 0) + 1 AS next_seq
       FROM contracts
      WHERE tenant_id = $1
        AND contract_number LIKE $2`,
    [tenantId, likePattern]
  );
  const nextSeq = Number(rows[0]?.next_seq) || 1;
  const seqStr = nextSeq < 10000 ? String(nextSeq).padStart(4, '0') : String(nextSeq);
  return `${prefix}-CON-${y}-${seqStr}`;
}

// ---------------------------------------------------------------------------
// Stay type derivation (option C — check nights_count, then dates, then default)
// ---------------------------------------------------------------------------

/**
 * Classify a booking into nightly | long_stay | contract_stay.
 * Returns null for non-nightly bookings (time_slots).
 *
 * Tiers (nights):
 *   <=14        nightly        (no contract)
 *   15-60       long_stay      (opt-in contract)
 *   >=61        contract_stay  (contract by default)
 */
function deriveStayType(booking) {
  if (!booking) return null;
  if (booking.booking_mode !== 'nightly') return null;

  let nights = toFiniteNumber(booking.nights_count);
  if (nights == null) {
    const ci = toDateOrNull(booking.checkin_date);
    const co = toDateOrNull(booking.checkout_date);
    if (ci && co) {
      const diffMs = co.getTime() - ci.getTime();
      const diffDays = diffMs / 86400000;
      if (Number.isFinite(diffDays) && diffDays >= 1) {
        nights = Math.round(diffDays);
      }
    }
  }

  // Safe default: if we still don't know, treat as nightly (no contract triggered).
  if (nights == null) return 'nightly';

  if (nights <= 14) return 'nightly';
  if (nights <= 60) return 'long_stay';
  return 'contract_stay';
}

// ---------------------------------------------------------------------------
// Milestone → due date resolution
// ---------------------------------------------------------------------------

/**
 * Given a milestone spec and a contract context, return the concrete DATE
 * this milestone is due on. Returned as ISO YYYY-MM-DD string for SQL DATE cast.
 *
 * Triggers:
 *   signing             — signedAt + due_offset_days   (default today)
 *   check_in            — startDate + due_offset_days
 *   mid_stay            — midpoint(startDate, endDate) + due_offset_days
 *   monthly_on_first    — 1st of month, (months_after_start) months after startDate
 *   monthly_relative    — startDate + (months_after_start) months
 */
function computeMilestoneDueDate(milestone, ctx) {
  const { startDate, endDate, signedAt } = ctx || {};
  const start = toDateOrNull(startDate);
  const end   = toDateOrNull(endDate);
  const signed = toDateOrNull(signedAt) || new Date();

  const offset = toFiniteNumber(milestone.due_offset_days) ?? 0;

  switch (milestone.trigger) {
    case 'signing':
      return toIsoDate(addDays(signed, offset));
    case 'check_in':
      if (!start) throw new Error('computeMilestoneDueDate: startDate required for check_in');
      return toIsoDate(addDays(start, offset));
    case 'mid_stay': {
      if (!start || !end) throw new Error('computeMilestoneDueDate: startDate+endDate required for mid_stay');
      const mid = new Date(start.getTime() + (end.getTime() - start.getTime()) / 2);
      return toIsoDate(addDays(mid, offset));
    }
    case 'monthly_on_first': {
      if (!start) throw new Error('computeMilestoneDueDate: startDate required for monthly_on_first');
      const months = toFiniteNumber(milestone.months_after_start) ?? 0;
      const target = addMonths(firstOfMonth(start), months);
      return toIsoDate(target);
    }
    case 'monthly_relative': {
      if (!start) throw new Error('computeMilestoneDueDate: startDate required for monthly_relative');
      const months = toFiniteNumber(milestone.months_after_start) ?? 0;
      return toIsoDate(addMonths(start, months));
    }
    default:
      throw new Error(`computeMilestoneDueDate: unknown trigger "${milestone.trigger}"`);
  }
}

// ---------------------------------------------------------------------------
// Template application
// ---------------------------------------------------------------------------

/**
 * Explode a template's milestones array into concrete invoice-ready rows.
 * Returns { snapshot, invoiceRows }:
 *   snapshot    — JSONB-safe array suitable for contracts.payment_schedule_snapshot
 *   invoiceRows — array of { milestone_index, milestone_label, amount, due_date }
 *
 * Rounding: each amount = totalValue * percent / 100, rounded to 3 decimals.
 * Residual cents (sum drift) absorbed by the last milestone so sum == totalValue.
 */
function applyTemplate({ template, totalValue, startDate, endDate, signedAt }) {
  if (!template || !Array.isArray(template.milestones) || template.milestones.length === 0) {
    throw new Error('applyTemplate: template with milestones[] required');
  }
  const total = roundMinor(totalValue);
  if (!Number.isFinite(total) || total < 0) {
    throw new Error('applyTemplate: totalValue must be a non-negative number');
  }

  const milestones = template.milestones;
  const n = milestones.length;

  // Validate percents sum to ~100 (allow 0.01 tolerance for fractional templates)
  const pctSum = milestones.reduce((acc, m) => acc + Number(m.percent || 0), 0);
  if (Math.abs(pctSum - 100) > 0.01) {
    throw new Error(`applyTemplate: milestone percents sum to ${pctSum}, expected 100`);
  }

  // Amount per milestone (rounded). Last one absorbs residual.
  const amounts = milestones.map(m => roundMinor(total * Number(m.percent) / 100));
  const sumAllButLast = amounts.slice(0, n - 1).reduce((a, b) => roundMinor(a + b), 0);
  amounts[n - 1] = roundMinor(total - sumAllButLast);

  const ctx = { startDate, endDate, signedAt };
  const dueDates = milestones.map(m => computeMilestoneDueDate(m, ctx));

  const snapshot = milestones.map((m, i) => ({
    milestone_index: i,
    label: m.label,
    percent: Number(m.percent),
    trigger: m.trigger,
    amount: amounts[i],
    due_date: dueDates[i],
  }));

  const invoiceRows = snapshot.map(s => ({
    milestone_index: s.milestone_index,
    milestone_label: s.label,
    amount: s.amount,
    due_date: s.due_date,
  }));

  return { snapshot, invoiceRows };
}

// ---------------------------------------------------------------------------
// Bulk insert contract_invoices inside a transaction
// ---------------------------------------------------------------------------

/**
 * Insert one row per invoice into contract_invoices.
 * Must be called inside a transaction.
 */
async function insertContractInvoices(client, { tenantId, contractId, currencyCode, invoiceRows }) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('insertContractInvoices: client required');
  }
  if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) return [];

  const insertedIds = [];
  for (const row of invoiceRows) {
    const { rows } = await client.query(
      `INSERT INTO contract_invoices
         (tenant_id, contract_id, milestone_index, milestone_label,
          amount, currency_code, status, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [
        tenantId,
        contractId,
        row.milestone_index,
        row.milestone_label,
        row.amount,
        currencyCode,
        row.due_date,
      ]
    );
    insertedIds.push(rows[0].id);
  }
  logger.info({ tenantId, contractId, count: insertedIds.length }, 'contract_invoices inserted');
  return insertedIds;
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

function toDateOrNull(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d) {
  // Returns YYYY-MM-DD (UTC date component). Avoids timezone drift when casting to DATE.
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, days) {
  if (!(d instanceof Date)) return null;
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function firstOfMonth(d) {
  if (!(d instanceof Date)) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d, months) {
  if (!(d instanceof Date)) return null;
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + months,
    d.getUTCDate()
  ));
}

function toFiniteNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------

module.exports = {
  // Primary API
  generateContractNumber,
  resolveContractPrefix,
  deriveStayType,
  applyTemplate,
  computeMilestoneDueDate,
  insertContractInvoices,

  // Exposed for tests + rounding consistency
  roundMinor,
  _internal: { toIsoDate, addDays, firstOfMonth, addMonths },
};
