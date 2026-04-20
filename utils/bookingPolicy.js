'use strict';

// utils/bookingPolicy.js
// PR 149: Server-side booking validation policy.
//
// Two independent gates, both tenant-configurable via tenants.branding JSONB:
//
//   branding.booking_policy.enforce_working_hours  (default: true)
//     → reject public bookings whose local start/end falls outside tenant_hours
//     → set to false for multi-timezone tenants (consultants, remote coaches)
//       who gate availability via rate rules instead
//
//   branding.booking_policy.require_charge         (default: false)
//     → reject public bookings that would be inserted with price_amount null/0
//     → set to true for tenants (like Birdie) that NEVER want a "free" booking
//       to slip through when rate rules don't cover a time
//     → membership/prepaid-covered bookings are exempt (those legitimately go to 0)
//
// Both gates are skipped for isAdminBypass requests (owner/staff manual creation).
//
// Usage:
//   const { getBookingPolicy, validateWithinWorkingHours } = require('../utils/bookingPolicy');
//   const policy = await getBookingPolicy(tenantId);
//   if (policy.enforceWorkingHours) {
//     const check = await validateWithinWorkingHours({ tenantId, tenantTz, startTime, durationMinutes });
//     if (!check.ok) return res.status(422).json({ error: check.message, code: check.code, details: check.details });
//   }

const db = require('../db');

// ─── Policy reader ───────────────────────────────────────────────────────────

const DEFAULT_POLICY = Object.freeze({
  enforceWorkingHours: true,   // safer default — prevents out-of-hours surprises
  requireCharge:       false,  // legacy default — many tenants have free services
});

function asBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    return ['1', 'true', 'yes', 'y', 'on'].includes(v.trim().toLowerCase());
  }
  return fallback;
}

/**
 * Read tenant booking policy from tenants.branding.booking_policy.
 * Returns a fully-populated policy object, with defaults applied for any
 * missing keys. Never throws — if DB fails or branding is missing, returns
 * DEFAULT_POLICY so validation still runs on safe defaults.
 *
 * @param {number|string} tenantId
 * @returns {Promise<{ enforceWorkingHours: boolean, requireCharge: boolean }>}
 */
async function getBookingPolicy(tenantId) {
  const tId = Number(tenantId);
  if (!Number.isFinite(tId) || tId <= 0) return { ...DEFAULT_POLICY };

  try {
    const { rows } = await db.query(
      `SELECT branding FROM tenants WHERE id = $1 LIMIT 1`,
      [tId]
    );
    const branding = rows[0]?.branding || {};
    const raw = branding.booking_policy || branding.bookingPolicy || {};

    return {
      enforceWorkingHours: asBool(
        raw.enforce_working_hours ?? raw.enforceWorkingHours,
        DEFAULT_POLICY.enforceWorkingHours
      ),
      requireCharge: asBool(
        raw.require_charge ?? raw.requireCharge,
        DEFAULT_POLICY.requireCharge
      ),
    };
  } catch (err) {
    // Fail-open to defaults (which are safer than bypassing validation entirely)
    return { ...DEFAULT_POLICY };
  }
}

// ─── Timezone-aware local time helpers ───────────────────────────────────────

/**
 * Extract local date, time, and day-of-week for a given instant in a given
 * IANA timezone. Uses Intl.DateTimeFormat for correctness across DST and
 * arbitrary offsets (handles Asia/Amman, America/New_York, Pacific/Apia, etc.).
 *
 * @param {Date|string} instant  — ISO string, Date, or timestamptz-parseable string
 * @param {string} timeZone      — IANA zone (e.g., 'Asia/Amman')
 * @returns {{ date: string, time: string, dayOfWeek: number, minutes: number }}
 *          date       YYYY-MM-DD in the zone
 *          time       HH:MM in the zone (24-hour)
 *          dayOfWeek  0=Sunday … 6=Saturday (matches tenant_hours column)
 *          minutes    minutes since local midnight (0–1439)
 */
function getLocalDateTime(instant, timeZone) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`getLocalDateTime: invalid instant "${instant}"`);
  }

  const tz = timeZone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);

  const pick = (type) => parts.find((p) => p.type === type)?.value || '00';
  const yyyy = pick('year');
  const mm   = pick('month');
  const dd   = pick('day');
  const HH   = pick('hour');
  const MM   = pick('minute');

  // Day-of-week is derived from the LOCAL date (not UTC) so it matches
  // what tenant_hours stores (0=Sunday relative to the tenant's own clock).
  const localMidnightUTC = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  const dayOfWeek = localMidnightUTC.getUTCDay();

  const minutes = parseInt(HH, 10) * 60 + parseInt(MM, 10);

  return {
    date:      `${yyyy}-${mm}-${dd}`,
    time:      `${HH}:${MM}`,
    dayOfWeek,
    minutes,
  };
}

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const s = String(hhmm).slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

// ─── Working-hours validator ─────────────────────────────────────────────────

const DEFAULT_OPEN  = '08:00';  // matches availabilityEngine DEFAULT_OPEN
const DEFAULT_CLOSE = '22:00';  // matches availabilityEngine DEFAULT_CLOSE

/**
 * Validate that [startTime, startTime + durationMinutes) falls entirely within
 * the tenant's working hours for the local day-of-week in the tenant's timezone.
 *
 * Uses the SAME defaults as utils/availabilityEngine.js so the create-time
 * check agrees with the slot-generation-time check (08:00–22:00 when no
 * tenant_hours row exists for that day).
 *
 * Overnight hours (open > close, e.g., 22:00 → 02:00) are handled correctly:
 * close is treated as +24h for the comparison.
 *
 * Returns:
 *   { ok: true }                                 — within hours
 *   { ok: false, code, message, details }        — outside hours
 *
 * Codes:
 *   'tenant_closed'           tenant_hours row has is_closed = true
 *   'outside_working_hours'   start or end falls outside [open, close]
 *   'invalid_working_hours'   tenant_hours row has unparseable times (data issue)
 *
 * @param {object} args
 * @param {number} args.tenantId
 * @param {string} args.tenantTz           IANA timezone
 * @param {Date|string} args.startTime     booking start (Date or timestamptz string)
 * @param {number} args.durationMinutes
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, details?: object }>}
 */
async function validateWithinWorkingHours({ tenantId, tenantTz, startTime, durationMinutes }) {
  const tz  = tenantTz || 'UTC';
  const dur = Number(durationMinutes) || 0;
  if (dur < 1) return { ok: true }; // nothing to validate; overlap check will catch it

  const startLocal = getLocalDateTime(startTime, tz);
  const startMin   = startLocal.minutes;
  const endMinRaw  = startMin + dur;

  // Look up the tenant's hours for THIS local day-of-week
  const { rows } = await db.query(
    `SELECT open_time, close_time, is_closed
       FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1`,
    [Number(tenantId), startLocal.dayOfWeek]
  );

  const row = rows[0] || null;

  if (row && row.is_closed) {
    return {
      ok: false,
      code: 'tenant_closed',
      message: 'This business is closed on the selected day.',
      details: {
        local_date:       startLocal.date,
        local_start:      startLocal.time,
        day_of_week:      startLocal.dayOfWeek,
        tenant_timezone:  tz,
      },
    };
  }

  const openHHMM  = String((row?.open_time  || DEFAULT_OPEN )).slice(0, 5);
  const closeHHMM = String((row?.close_time || DEFAULT_CLOSE)).slice(0, 5);

  const openMin  = timeToMinutes(openHHMM);
  let   closeMin = timeToMinutes(closeHHMM);

  if (openMin == null || closeMin == null) {
    return {
      ok: false,
      code: 'invalid_working_hours',
      message: 'Tenant working hours are not configured correctly.',
      details: {
        local_date:      startLocal.date,
        day_of_week:     startLocal.dayOfWeek,
        tenant_timezone: tz,
        open_time:       row?.open_time,
        close_time:      row?.close_time,
      },
    };
  }

  // Overnight hours: close <= open means close is on the next day.
  // We normalise by adding 24h to close AND to the booking end if
  // start is before open (rare case where start is after midnight).
  const isOvernight = closeMin <= openMin;
  if (isOvernight) closeMin += 24 * 60;

  // If the booking starts in the "after-midnight" tail of an overnight window,
  // shift its start/end by 24h so they're comparable against the same scale.
  let startMinCmp = startMin;
  let endMinCmp   = endMinRaw;
  if (isOvernight && startMin < openMin) {
    startMinCmp = startMin + 24 * 60;
    endMinCmp   = endMinRaw + 24 * 60;
  }

  const withinStart = startMinCmp >= openMin;
  const withinEnd   = endMinCmp   <= closeMin;

  if (!withinStart || !withinEnd) {
    // Reformat end time for the response even if it wraps past midnight
    const endMinMod = endMinRaw % (24 * 60);
    const endHH = String(Math.floor(endMinMod / 60)).padStart(2, '0');
    const endMM = String(endMinMod % 60).padStart(2, '0');

    return {
      ok: false,
      code: 'outside_working_hours',
      message: `Booking time is outside business hours (${openHHMM}–${String(closeHHMM)}).`,
      details: {
        local_date:       startLocal.date,
        local_start:      startLocal.time,
        local_end:        `${endHH}:${endMM}`,
        day_of_week:      startLocal.dayOfWeek,
        tenant_timezone:  tz,
        working_hours:    { open: openHHMM, close: closeHHMM },
        used_default:     !row,
      },
    };
  }

  return { ok: true };
}

// ─── Charge-required validator ───────────────────────────────────────────────

/**
 * Check whether a booking satisfies the "must have a real charge" policy.
 * Called AFTER price_amount / charge_amount have been resolved in create.js
 * and BEFORE the INSERT, so the tenant never gets a surprise $0 booking
 * when they've opted into requireCharge.
 *
 * A booking is valid (returns { ok: true }) when:
 *   - Membership covered it (finalCustomerMembershipId is truthy), OR
 *   - Prepaid package covered it (prepaidApplied is truthy), OR
 *   - price_amount is a finite number > 0
 *
 * Membership/prepaid exemption is deliberate: those are explicit tenant-
 * configured "free to customer, accounted for via ledger" paths. The bug
 * this validator closes is the IMPLICIT free path where no rate rule
 * matched and price_amount silently came back null.
 *
 * @returns {{ ok: boolean, code?: string, message?: string, details?: object }}
 */
function validateRequireCharge({
  priceAmount,
  finalCustomerMembershipId,
  prepaidApplied,
  serviceId,
}) {
  if (finalCustomerMembershipId) return { ok: true };
  if (prepaidApplied)            return { ok: true };

  const p = Number(priceAmount);
  if (Number.isFinite(p) && p > 0) return { ok: true };

  return {
    ok: false,
    code: 'charge_required',
    message: 'This business does not accept bookings without a charge. The selected time has no applicable rate.',
    details: {
      price_amount:  priceAmount,
      service_id:    serviceId,
      policy:        'require_charge',
    },
  };
}

module.exports = {
  DEFAULT_POLICY,
  getBookingPolicy,
  validateWithinWorkingHours,
  validateRequireCharge,
  // Exported for tests
  getLocalDateTime,
  timeToMinutes,
};
