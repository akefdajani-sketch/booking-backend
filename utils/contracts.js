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

// ---------------------------------------------------------------------------
// CONTRACT-CALENDAR-1: Phantom booking + resource lease sync
// ---------------------------------------------------------------------------
//
// When a contract transitions to 'signed' (or is created with initial_status
// 'signed' via fast-confirm), three side-effects must happen inside the same
// transaction:
//
//   1. materializeContractBooking() — INSERT a phantom row into bookings so
//      the existing checkNightlyAvailability SQL (which only reads bookings)
//      treats the unit as occupied for the contract window. Carries
//      total_amount = contract.total_value so dashboard revenue queries
//      pick it up automatically.
//
//   2. syncResourceLeaseFromContract(..., 'apply') — write contract dates +
//      tenant name + monthly_rate onto resources.lease_* fields. This keeps
//      the existing lease guard (rentalAvailabilityEngine.js lines 48–93)
//      consistent and makes the resource edit panel reflect live contracts.
//
// On terminate/cancel/expire/completed:
//
//   1. cancelContractBooking() soft-deletes the phantom booking.
//   2. syncResourceLeaseFromContract(..., 'release') reverts resource fields
//      ONLY when contract.auto_release_on_expiry is true (matches the
//      existing checkbox semantic — host can keep lease info historical).
//
// All three helpers are idempotent and take a transactional client (not the
// pool) so callers control commit/rollback.

/**
 * Insert a phantom booking representing a contract on the calendar.
 * Idempotent: if contract.booking_id already points to a non-deleted booking,
 * returns that booking_id without inserting.
 *
 * Returns: { bookingId, created } where created=false means the booking
 * already existed.
 */
async function materializeContractBooking(client, contract) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('materializeContractBooking: transactional client required');
  }
  if (!contract || !contract.id || !contract.tenant_id) {
    throw new Error('materializeContractBooking: contract with id and tenant_id required');
  }
  if (!contract.resource_id || !contract.start_date || !contract.end_date) {
    throw new Error('materializeContractBooking: contract missing resource_id/start_date/end_date');
  }

  // Idempotency: if a phantom already exists and is live, do nothing.
  if (contract.booking_id) {
    const existing = await client.query(
      `SELECT id FROM bookings
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [contract.booking_id, contract.tenant_id]
    );
    if (existing.rows.length) {
      return { bookingId: Number(contract.booking_id), created: false };
    }
  }

  // Also defensive: search for an existing live phantom by contract_id.
  // Handles the case where booking_id wasn't written back due to a partial
  // historical state.
  const orphan = await client.query(
    `SELECT id FROM bookings
      WHERE tenant_id = $1 AND contract_id = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [contract.tenant_id, contract.id]
  );
  if (orphan.rows.length) {
    const existingId = Number(orphan.rows[0].id);
    // Backfill the link on contracts so future calls find it via the fast path.
    await client.query(
      `UPDATE contracts SET booking_id = $1, updated_at = NOW() WHERE id = $2`,
      [existingId, contract.id]
    );
    return { bookingId: existingId, created: false };
  }

  // MATERIALIZE-DATE-FIX: contract.start_date / contract.end_date come back
  // from node-postgres as JavaScript Date objects (DATE columns are parsed,
  // not returned as raw strings). String(dateObj) yields the toString form
  // ("Fri May 01 2026 03:00:00 GMT+0300 (...)"), and .slice(0, 10) of that
  // is "Fri May 01" — concatenating "T00:00:00Z" produces the gibberish
  // "Fri May 01T00:00:00Z" which Postgres rejects with code 22007 the moment
  // we try to bind it as TIMESTAMPTZ.
  //
  // Same gotcha was already fixed in _getBookingBlockedDates further down in
  // this file; the fix never reached this function. This is the bug behind
  // 500s on POST /api/contracts when initial_status='signed' (Confirm now).
  const startDateStr = (contract.start_date instanceof Date)
    ? contract.start_date.toISOString().slice(0, 10)
    : String(contract.start_date).slice(0, 10);
  const endDateStr = (contract.end_date instanceof Date)
    ? contract.end_date.toISOString().slice(0, 10)
    : String(contract.end_date).slice(0, 10);

  // Nights = ceil days between start and end (DATE columns, day-precision).
  const startMs = Date.parse(`${startDateStr}T00:00:00Z`);
  const endMs   = Date.parse(`${endDateStr}T00:00:00Z`);
  const nights  = Math.max(1, Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)));
  const durationMinutes = nights * 1440;

  // start_time / end_time as TIMESTAMPTZ at midnight UTC of the relevant
  // dates. Matches the convention nightly bookings already use.
  const startTimeIso = `${startDateStr}T00:00:00Z`;
  const endTimeIso   = `${endDateStr}T00:00:00Z`;

  const totalValue = roundMinor(Number(contract.total_value) || 0);
  const currency   = String(contract.currency_code || 'JOD').trim().toUpperCase();

  // CONTRACT-SERVICE-LOOKUP: bookings.service_id has a NOT NULL constraint
  // but the contracts table has no service_id column — contracts are bound
  // to a resource (a unit), not a service. Pick a sensible nightly service
  // from this tenant for the phantom booking.
  //
  // Strategy:
  //   1. Prefer a nightly service whose name contains "long" (the convention
  //      tenants use to label long-term services, e.g. Aqaba's "Long Term").
  //   2. Fall back to the lowest-id nightly service.
  //   3. If the tenant has no nightly service at all, fail with a helpful
  //      error rather than letting the NOT NULL violation surface as a 500.
  //
  // Defensive: filter on deleted_at only if the column exists.
  const svcColsRes = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'services'`
  );
  const svcHasDeletedAt = svcColsRes.rows.some(r => r.column_name === 'deleted_at');
  const svcSql = `
    SELECT id FROM services
     WHERE tenant_id    = $1
       AND booking_mode = 'nightly'
       ${svcHasDeletedAt ? 'AND deleted_at IS NULL' : ''}
     ORDER BY
       CASE WHEN LOWER(name) LIKE '%long%' THEN 0 ELSE 1 END,
       id ASC
     LIMIT 1
  `;
  const svcRes = await client.query(svcSql, [contract.tenant_id]);
  if (!svcRes.rows.length) {
    throw new Error(
      `materializeContractBooking: tenant ${contract.tenant_id} has no nightly service — ` +
      `create at least one nightly service before signing a contract`
    );
  }
  const serviceId = Number(svcRes.rows[0].id);

  // Build column list dynamically — different deployments have different
  // optional columns added by various migrations. We INSERT only what's
  // present in the schema to stay backwards-compatible.
  const colsRes = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bookings'`
  );
  const cols = new Set(colsRes.rows.map(r => r.column_name));

  const fields = ['tenant_id', 'customer_id', 'service_id', 'resource_id', 'start_time', 'end_time', 'duration_minutes', 'status'];
  const values = [contract.tenant_id, contract.customer_id || null, serviceId, contract.resource_id, startTimeIso, endTimeIso, durationMinutes, 'confirmed'];

  const add = (col, val) => { if (cols.has(col)) { fields.push(col); values.push(val); } };

  add('booking_mode',    'nightly');
  add('stay_type',       'contract_stay');
  add('checkin_date',    startDateStr);
  add('checkout_date',   endDateStr);
  add('nights_count',    nights);
  add('contract_id',     contract.id);
  add('total_amount',    totalValue);
  add('charge_amount',   totalValue);
  add('subtotal_amount', totalValue);
  add('currency_code',   currency);
  add('notes',           `Auto-generated from contract ${contract.contract_number || contract.id}`);

  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const insertRes = await client.query(
    `INSERT INTO bookings (${fields.join(', ')})
     VALUES (${placeholders})
     RETURNING id`,
    values
  );
  const newId = Number(insertRes.rows[0].id);

  // Link contract → booking
  await client.query(
    `UPDATE contracts SET booking_id = $1, updated_at = NOW() WHERE id = $2`,
    [newId, contract.id]
  );

  return { bookingId: newId, created: true };
}

/**
 * Soft-delete the phantom booking for a contract.
 * Idempotent: if no live phantom exists, returns { cancelled: false }.
 */
async function cancelContractBooking(client, contract) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('cancelContractBooking: transactional client required');
  }
  if (!contract || !contract.id || !contract.tenant_id) {
    throw new Error('cancelContractBooking: contract with id and tenant_id required');
  }

  // Find live phantom — prefer contract.booking_id, fall back to scan by
  // contract_id (handles legacy rows where the FK wasn't written back).
  const found = await client.query(
    `SELECT id FROM bookings
      WHERE tenant_id = $1
        AND (id = $2 OR contract_id = $3)
        AND deleted_at IS NULL
      LIMIT 1`,
    [contract.tenant_id, contract.booking_id || -1, contract.id]
  );
  if (!found.rows.length) {
    return { cancelled: false, bookingId: null };
  }

  const bookingId = Number(found.rows[0].id);
  await client.query(
    `UPDATE bookings
        SET deleted_at = NOW(),
            status = 'cancelled',
            updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2`,
    [bookingId, contract.tenant_id]
  );
  return { cancelled: true, bookingId };
}

/**
 * Sync resource lease fields from contract.
 * mode = 'apply'   → write contract dates onto resources.lease_*
 * mode = 'release' → revert lease fields IF contract.auto_release_on_expiry
 *
 * Honors auto_release_on_expiry on release: when false, leaves fields alone
 * so the host keeps historical lease info (matches existing checkbox UX).
 */
async function syncResourceLeaseFromContract(client, contract, mode) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('syncResourceLeaseFromContract: transactional client required');
  }
  if (!contract || !contract.tenant_id || !contract.resource_id) {
    throw new Error('syncResourceLeaseFromContract: contract with tenant_id and resource_id required');
  }
  if (mode !== 'apply' && mode !== 'release') {
    throw new Error(`syncResourceLeaseFromContract: invalid mode "${mode}"`);
  }

  // Check what columns exist on resources — older deployments may lack
  // some of the rental management fields.
  const colsRes = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'resources'`
  );
  const cols = new Set(colsRes.rows.map(r => r.column_name));
  if (!cols.has('rental_type')) return { synced: false, reason: 'rental_type column missing' };

  if (mode === 'release') {
    if (!contract.auto_release_on_expiry) {
      return { synced: false, reason: 'auto_release_on_expiry=false; lease fields preserved' };
    }
    const sets = [`rental_type = 'short_term'`];
    if (cols.has('lease_start'))           sets.push(`lease_start = NULL`);
    if (cols.has('lease_end'))             sets.push(`lease_end = NULL`);
    if (cols.has('lease_tenant_name'))     sets.push(`lease_tenant_name = NULL`);
    if (cols.has('lease_tenant_phone'))    sets.push(`lease_tenant_phone = NULL`);
    if (cols.has('monthly_rate'))          sets.push(`monthly_rate = NULL`);
    sets.push(`updated_at = NOW()`);
    await client.query(
      `UPDATE resources SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2`,
      [contract.resource_id, contract.tenant_id]
    );
    return { synced: true, mode: 'release' };
  }

  // mode === 'apply'
  // Look up customer name + phone for lease_tenant_* fields.
  let tenantName = null;
  let tenantPhone = null;
  if (contract.customer_id) {
    const cust = await client.query(
      `SELECT name, phone FROM customers WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [contract.customer_id, contract.tenant_id]
    );
    if (cust.rows.length) {
      tenantName  = cust.rows[0].name  || null;
      tenantPhone = cust.rows[0].phone || null;
    }
  }

  const startDateStr = (contract.start_date instanceof Date)
    ? contract.start_date.toISOString().slice(0, 10)
    : String(contract.start_date).slice(0, 10);
  const endDateStr = (contract.end_date instanceof Date)
    ? contract.end_date.toISOString().slice(0, 10)
    : String(contract.end_date).slice(0, 10);
  // 'flexible' means the unit auto-releases for short-term after lease end.
  // 'long_term' means the unit is locked under lease until manually changed.
  const rentalType = contract.auto_release_on_expiry ? 'flexible' : 'long_term';
  const monthlyRate = contract.monthly_rate != null ? Number(contract.monthly_rate) : null;

  const sets    = [`rental_type = $3`];
  const params  = [contract.resource_id, contract.tenant_id, rentalType];
  let p = 3;
  const addCol = (col, val) => {
    if (!cols.has(col)) return;
    p += 1;
    sets.push(`${col} = $${p}`);
    params.push(val);
  };
  addCol('lease_start',           startDateStr);
  addCol('lease_end',              endDateStr);
  addCol('lease_tenant_name',      tenantName);
  addCol('lease_tenant_phone',     tenantPhone);
  addCol('monthly_rate',           monthlyRate);
  addCol('auto_release_on_expiry', !!contract.auto_release_on_expiry);
  sets.push(`updated_at = NOW()`);

  await client.query(
    `UPDATE resources SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2`,
    params
  );

  return { synced: true, mode: 'apply', rentalType };
}

module.exports = {
  // Primary API
  generateContractNumber,
  resolveContractPrefix,
  deriveStayType,
  applyTemplate,
  computeMilestoneDueDate,
  insertContractInvoices,

  // CONTRACT-CALENDAR-1: phantom-booking + lease sync
  materializeContractBooking,
  cancelContractBooking,
  syncResourceLeaseFromContract,

  // Exposed for tests + rounding consistency
  roundMinor,
  _internal: { toIsoDate, addDays, firstOfMonth, addMonths },
};
