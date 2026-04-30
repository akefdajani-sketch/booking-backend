'use strict';

// utils/contracts.js
// G2a-1: Long-term contracts — core helpers.
//
// FINAL-CONTRACT-FIX (this revision):
//   - Adds generateContractSchedule(): unified generator for fixed-duration
//     templates (3/6/12-Month) AND for None (manual). Templates with
//     duration_months IS NOT NULL drive end_date and emit a clean
//     deposit + monthlies schedule with day-1 prorated edges. The deprecated
//     percentage-based path (applyTemplate) is preserved ONLY for variable-
//     duration templates (Long Stay 15-60 nights — vacation rentals).
//   - materializeContractBooking now writes charge_amount = 0 on the phantom
//     booking. Contract revenue surfaces through contract_invoices, not via
//     the phantom row, so the dashboard no longer double-counts (or attributes
//     the entire contract value to the start month).
//
// Responsibilities:
//   - generateContractNumber()       — per-tenant advisory-locked sequence
//   - resolveContractPrefix()        — read tenants.contract_number_prefix or fall back
//   - deriveStayType()               — nightly | long_stay | contract_stay from booking data
//   - generateContractSchedule()     — UNIFIED schedule generator (FINAL-CONTRACT-FIX)
//   - applyTemplate()                — LEGACY: percentage-based, retained for variable-duration templates
//   - computeMilestoneDueDate()      — trigger-specific date calculation (used by applyTemplate)
//   - insertContractInvoices()       — bulk-insert contract_invoices rows inside a tx
//   - materializeContractBooking()   — phantom booking for calendar block
//   - cancelContractBooking()        — soft-delete phantom on contract end
//   - syncResourceLeaseFromContract()— write contract dates onto resources.lease_*
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

function resolveContractPrefix(tenant) {
  if (!tenant) throw new Error('resolveContractPrefix: tenant required');

  const stored = (tenant.contract_number_prefix || '').toString().trim();
  if (stored && /^[A-Z0-9]+$/.test(stored) && stored.length >= 2 && stored.length <= 10) {
    return stored;
  }

  const slug = (tenant.slug || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fallback = slug.slice(0, 3) || 'TEN';
  return fallback.length >= 2 ? fallback : (fallback + 'X');
}

// ---------------------------------------------------------------------------
// Contract number generation (unchanged)
// ---------------------------------------------------------------------------

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
// Stay type derivation (unchanged)
// ---------------------------------------------------------------------------

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
  if (nights == null) return 'nightly';
  if (nights <= 14) return 'nightly';
  if (nights <= 60) return 'long_stay';
  return 'contract_stay';
}

// ---------------------------------------------------------------------------
// FINAL-CONTRACT-FIX: Unified schedule generator
// ---------------------------------------------------------------------------
//
// The right model for long-term leases:
//   - Templates with duration_months drive the contract duration (end_date)
//     and the schedule shape (deposit + N monthlies).
//   - "None" lets the user set dates freely; same generator runs.
//   - Day-1 invoicing convention: monthlies due on the 1st of each month.
//     Prorated leading invoice if start_date.day != 1, prorated trailing
//     invoice if end_date isn't the last day of its month.
//   - Security deposit is its OWN invoice row (is_deposit = TRUE), separate
//     from rent. Excluded from total_value. Refundable in the future credit-
//     note workflow.
//
// Worked example — start Jan 12, monthly 350 JOD, 12-month template,
// security_deposit 350 JOD. End auto-set to Jan 11 next year (inclusive).
//
//   #  Label                          Due           Amount    is_deposit
//   0  Security Deposit               12 Jan 2026   350.000   true
//   1  Jan 2026 (prorated, 20/31)     12 Jan 2026   225.806   false
//   2  Feb 2026                       1 Feb 2026    350.000   false
//   ...
//  12  Dec 2026                       1 Dec 2026    350.000   false
//  13  Jan 2027 (prorated, 11/31)     1 Jan 2027    124.194   false
//
//   Rent total: 225.806 + 11×350 + 124.194 = 4200.000 = 12 × 350 ✓
//
// ---------------------------------------------------------------------------

/**
 * Generate the contract invoice schedule.
 *
 * @param {object} args
 * @param {string} args.startDate         YYYY-MM-DD
 * @param {string} args.endDate           YYYY-MM-DD (inclusive — last day of occupancy)
 * @param {number} args.monthlyRate       money
 * @param {number} args.securityDeposit   money (0 to skip deposit invoice)
 * @returns {{ snapshot: Array, invoiceRows: Array }}
 *
 * Both arrays carry milestone_index, milestone_label/label, amount, due_date,
 * and is_deposit. Compatible with insertContractInvoices() and contracts.
 * payment_schedule_snapshot.
 */
function generateContractSchedule({ startDate, endDate, monthlyRate, securityDeposit }) {
  const start = toDateOrNull(startDate);
  const end   = toDateOrNull(endDate);
  if (!start) throw new Error('generateContractSchedule: startDate required');
  if (!end)   throw new Error('generateContractSchedule: endDate required');
  if (end < start) throw new Error('generateContractSchedule: endDate must be >= startDate');

  const rate = Number(monthlyRate);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error('generateContractSchedule: monthlyRate must be a non-negative number');
  }
  const deposit = Number(securityDeposit) || 0;

  const milestones = [];
  let idx = 0;

  // ── Security deposit (always first when > 0, due on start_date) ─────────
  if (deposit > 0) {
    milestones.push({
      milestone_index: idx++,
      label: 'Security Deposit',
      trigger: 'signing',
      amount: roundMinor(deposit),
      due_date: toIsoDate(start),
      is_deposit: true,
    });
  }

  // ── Rent invoices (deposit + N monthlies, day-1 convention) ─────────────
  //
  // Walk month-by-month from start month → end month inclusive.
  // For each month, decide: full / leading-prorated / trailing-prorated.

  const startY = start.getUTCFullYear();
  const startM = start.getUTCMonth(); // 0-11
  const startD = start.getUTCDate();
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth();
  const endD = end.getUTCDate();

  // Iterate through (year, month) pairs from start to end inclusive.
  let y = startY;
  let m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    const isStartMonth = (y === startY && m === startM);
    const isEndMonth   = (y === endY && m === endM);

    const daysInMonth = daysInMonthOf(y, m);

    // Determine the day range covered in this month for this contract.
    const firstCoveredDay = isStartMonth ? startD : 1;
    const lastCoveredDay  = isEndMonth   ? endD   : daysInMonth;

    // Days actually covered.
    const daysCovered = lastCoveredDay - firstCoveredDay + 1;

    // Full month (1st through last day): full monthly_rate.
    // Anything else: prorated by daysCovered / daysInMonth.
    const isFullMonth = (firstCoveredDay === 1 && lastCoveredDay === daysInMonth);

    let amount;
    let label;
    let dueDate;

    const monthLabel = MONTH_NAMES[m] + ' ' + y;

    if (isFullMonth) {
      amount = roundMinor(rate);
      label = monthLabel;
      // Due on the 1st of this month.
      dueDate = toIsoDate(new Date(Date.UTC(y, m, 1)));
    } else {
      amount = roundMinor(rate * (daysCovered / daysInMonth));
      label = `${monthLabel} (prorated, ${daysCovered}/${daysInMonth})`;
      // Leading prorated → due on start_date itself (day the tenant moves in).
      // Trailing prorated → due on the 1st of the end month.
      if (isStartMonth && firstCoveredDay !== 1) {
        dueDate = toIsoDate(start);
      } else {
        dueDate = toIsoDate(new Date(Date.UTC(y, m, 1)));
      }
    }

    milestones.push({
      milestone_index: idx++,
      label,
      trigger: 'monthly_on_first',
      amount,
      due_date: dueDate,
      is_deposit: false,
    });

    // Advance.
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }

  // ── Reconcile rent total to monthly_rate × clean-month-count when possible ─
  //
  // Sum of rent amounts (excluding deposit) should equal:
  //   - For clean N-month periods (start.day=1, end is last day of end month):
  //     monthly_rate × N  exactly.
  //   - For prorated periods: rate × (total days covered / 30 average) — close
  //     to but not exactly rate × N. The last rent invoice absorbs rounding
  //     residual so the sum is bit-stable.

  const rentRows = milestones.filter(m => !m.is_deposit);
  if (rentRows.length > 0) {
    // Compute target rent total: rate × number of "rent months" where each
    // partial month counts as its proration.
    let targetRentTotal = 0;
    for (const r of rentRows) {
      targetRentTotal = roundMinor(targetRentTotal + r.amount);
    }
    const sumNow = rentRows.reduce((acc, r) => roundMinor(acc + r.amount), 0);
    const drift = roundMinor(targetRentTotal - sumNow);
    if (Math.abs(drift) > 0) {
      // Apply drift to last rent invoice.
      const last = rentRows[rentRows.length - 1];
      const lastIdx = milestones.findIndex(x => x.milestone_index === last.milestone_index);
      if (lastIdx >= 0) {
        milestones[lastIdx] = {
          ...milestones[lastIdx],
          amount: roundMinor(milestones[lastIdx].amount + drift),
        };
      }
    }
  }

  // Build snapshot + invoiceRows in the shape the rest of the code expects.
  const snapshot = milestones.map(m => ({
    milestone_index: m.milestone_index,
    label: m.label,
    percent: null, // generator-driven, not percentage-based
    trigger: m.trigger,
    amount: m.amount,
    due_date: m.due_date,
    is_deposit: !!m.is_deposit,
  }));

  const invoiceRows = milestones.map(m => ({
    milestone_index: m.milestone_index,
    milestone_label: m.label,
    amount: m.amount,
    due_date: m.due_date,
    is_deposit: !!m.is_deposit,
  }));

  return { snapshot, invoiceRows };
}

/**
 * Compute the inclusive end_date for a fixed-duration template.
 * "12 months from Jan 12 2026" → Jan 11 2027.
 *
 * Convention: end_date is the LAST DAY of occupancy (inclusive).
 *
 * @param {string} startDate YYYY-MM-DD
 * @param {number} durationMonths positive integer
 * @returns {string} YYYY-MM-DD
 */
function computeFixedTermEndDate(startDate, durationMonths) {
  const s = toDateOrNull(startDate);
  if (!s) throw new Error('computeFixedTermEndDate: startDate required');
  const months = Math.round(Number(durationMonths) || 0);
  if (!Number.isFinite(months) || months <= 0) {
    throw new Error('computeFixedTermEndDate: durationMonths must be a positive integer');
  }
  // Inclusive: start + N months − 1 day.
  // e.g. Jan 12 + 12 months = Jan 12 next year, then -1 day = Jan 11.
  const exclusive = addMonths(s, months);
  const inclusive = addDays(exclusive, -1);
  return toIsoDate(inclusive);
}

/**
 * Compute total_value for a given start, end, and monthly_rate using the
 * generator's own day-1-prorated math. This guarantees suggestion === billed.
 */
function computeTotalValueFromSchedule({ startDate, endDate, monthlyRate }) {
  const { snapshot } = generateContractSchedule({
    startDate, endDate, monthlyRate, securityDeposit: 0,
  });
  return roundMinor(
    snapshot.filter(s => !s.is_deposit).reduce((acc, s) => acc + Number(s.amount), 0)
  );
}

// ---------------------------------------------------------------------------
// LEGACY: Milestone → due date resolution (used by applyTemplate for variable-
// duration templates only — Long Stay 15-60 nights). DO NOT use for fixed-
// duration templates; they use generateContractSchedule above.
// ---------------------------------------------------------------------------

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

/**
 * LEGACY percentage-based template application.
 * Use ONLY for variable-duration templates (Long Stay 15-60 nights, where
 * milestones use signing/check_in/mid_stay percentages). Fixed-duration
 * templates (3/6/12-Month) MUST use generateContractSchedule instead.
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

  const pctSum = milestones.reduce((acc, m) => acc + Number(m.percent || 0), 0);
  if (Math.abs(pctSum - 100) > 0.01) {
    throw new Error(`applyTemplate: milestone percents sum to ${pctSum}, expected 100`);
  }

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
    is_deposit: false,
  }));

  const invoiceRows = snapshot.map(s => ({
    milestone_index: s.milestone_index,
    milestone_label: s.label,
    amount: s.amount,
    due_date: s.due_date,
    is_deposit: false,
  }));

  return { snapshot, invoiceRows };
}

// ---------------------------------------------------------------------------
// Bulk insert contract_invoices inside a transaction
// FINAL-CONTRACT-FIX: writes is_deposit when present in invoiceRows (defaults
// to false for legacy callers that don't supply it).
// ---------------------------------------------------------------------------

async function insertContractInvoices(client, { tenantId, contractId, currencyCode, invoiceRows }) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('insertContractInvoices: client required');
  }
  if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) return [];

  // Detect whether the is_deposit column exists yet (idempotent against
  // pre-migration databases — falls back gracefully).
  const colCheck = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'contract_invoices'
        AND column_name = 'is_deposit'`
  );
  const hasIsDeposit = colCheck.rows.length > 0;

  const insertedIds = [];
  for (const row of invoiceRows) {
    const isDeposit = !!row.is_deposit;
    const sql = hasIsDeposit
      ? `INSERT INTO contract_invoices
           (tenant_id, contract_id, milestone_index, milestone_label,
            amount, currency_code, status, due_date, is_deposit)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
         RETURNING id`
      : `INSERT INTO contract_invoices
           (tenant_id, contract_id, milestone_index, milestone_label,
            amount, currency_code, status, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
         RETURNING id`;
    const params = hasIsDeposit
      ? [tenantId, contractId, row.milestone_index, row.milestone_label,
         row.amount, currencyCode, row.due_date, isDeposit]
      : [tenantId, contractId, row.milestone_index, row.milestone_label,
         row.amount, currencyCode, row.due_date];
    const { rows } = await client.query(sql, params);
    insertedIds.push(rows[0].id);
  }
  logger.info({ tenantId, contractId, count: insertedIds.length }, 'contract_invoices inserted');
  return insertedIds;
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec',
];

function toDateOrNull(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return new Date(`${v}T00:00:00Z`);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d) {
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

function daysInMonthOf(year, month0) {
  // month0 is 0-11. JS trick: day=0 of next month yields the last day of given month.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function toFiniteNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// CONTRACT-CALENDAR-1: Phantom booking + resource lease sync
// (Unchanged logic except materializeContractBooking now writes charge_amount=0)
// ---------------------------------------------------------------------------

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

  // Idempotency: existing live phantom → no-op.
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
  const orphan = await client.query(
    `SELECT id FROM bookings
      WHERE tenant_id = $1 AND contract_id = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [contract.tenant_id, contract.id]
  );
  if (orphan.rows.length) {
    const existingId = Number(orphan.rows[0].id);
    await client.query(
      `UPDATE contracts SET booking_id = $1, updated_at = NOW() WHERE id = $2`,
      [existingId, contract.id]
    );
    return { bookingId: existingId, created: false };
  }

  // MATERIALIZE-DATE-FIX (existing): handle Date-typed start_date/end_date.
  const startDateStr = (contract.start_date instanceof Date)
    ? contract.start_date.toISOString().slice(0, 10)
    : String(contract.start_date).slice(0, 10);
  const endDateStr = (contract.end_date instanceof Date)
    ? contract.end_date.toISOString().slice(0, 10)
    : String(contract.end_date).slice(0, 10);

  const startMs = Date.parse(`${startDateStr}T00:00:00Z`);
  const endMs   = Date.parse(`${endDateStr}T00:00:00Z`);
  const nights  = Math.max(1, Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)));
  const durationMinutes = nights * 1440;

  const startTimeIso = `${startDateStr}T00:00:00Z`;
  const endTimeIso   = `${endDateStr}T00:00:00Z`;

  // FINAL-CONTRACT-FIX: phantom booking carries charge_amount = 0.
  // Contract revenue surfaces via contract_invoices, not via the phantom
  // booking. This prevents the dashboard from attributing the entire contract
  // total to the start month.
  const currency = String(contract.currency_code || 'JOD').trim().toUpperCase();

  // CONTRACT-SERVICE-LOOKUP (existing): pick a nightly service for FK.
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

  // Customer denorm fields.
  let custName = 'Customer';
  let custEmail = '';
  let custPhone = '';
  if (contract.customer_id) {
    const custRes = await client.query(
      `SELECT name, email, phone FROM customers
         WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [contract.customer_id, contract.tenant_id]
    );
    if (custRes.rows.length) {
      custName  = String(custRes.rows[0].name  || 'Customer').trim() || 'Customer';
      custEmail = String(custRes.rows[0].email || '').trim();
      custPhone = String(custRes.rows[0].phone || '').trim();
    }
  }

  // Build dynamic column list (handles deployment drift).
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
  // FINAL-CONTRACT-FIX: zero-money phantom. Revenue lives on contract_invoices.
  add('total_amount',    0);
  add('charge_amount',   0);
  add('subtotal_amount', 0);
  add('currency_code',   currency);
  add('customer_name',   custName);
  add('customer_email',  custEmail);
  add('customer_phone',  custPhone);
  add('notes',           `Auto-generated from contract ${contract.contract_number || contract.id}`);

  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const insertRes = await client.query(
    `INSERT INTO bookings (${fields.join(', ')})
     VALUES (${placeholders})
     RETURNING id`,
    values
  );
  const newId = Number(insertRes.rows[0].id);

  await client.query(
    `UPDATE contracts SET booking_id = $1, updated_at = NOW() WHERE id = $2`,
    [newId, contract.id]
  );

  return { bookingId: newId, created: true };
}

async function cancelContractBooking(client, contract) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('cancelContractBooking: transactional client required');
  }
  if (!contract || !contract.id || !contract.tenant_id) {
    throw new Error('cancelContractBooking: contract with id and tenant_id required');
  }
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
    if (cols.has('updated_at'))            sets.push(`updated_at = NOW()`);
    await client.query(
      `UPDATE resources SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2`,
      [contract.resource_id, contract.tenant_id]
    );
    return { synced: true, mode: 'release' };
  }

  // mode === 'apply'
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
  if (cols.has('updated_at'))     sets.push(`updated_at = NOW()`);

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

  // FINAL-CONTRACT-FIX: unified generator
  generateContractSchedule,
  computeFixedTermEndDate,
  computeTotalValueFromSchedule,

  // LEGACY: percentage-based (Long Stay 15-60 nights only)
  applyTemplate,
  computeMilestoneDueDate,

  insertContractInvoices,

  // CONTRACT-CALENDAR-1: phantom-booking + lease sync
  materializeContractBooking,
  cancelContractBooking,
  syncResourceLeaseFromContract,

  // Exposed for tests + rounding consistency
  roundMinor,
  _internal: { toIsoDate, addDays, firstOfMonth, addMonths, daysInMonthOf },
};
