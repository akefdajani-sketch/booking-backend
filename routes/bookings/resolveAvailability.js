'use strict';

// routes/bookings/resolveAvailability.js
//
// Pre-BEGIN service load + availability verification for the booking
// creation engine. Extracted from routes/bookings/create.js
// (PR 3, Phase 1 refactor).
//
// Responsibility: load the service row (with forward-compat column probes)
// and verify that the requested slot is bookable against tenant rules —
// blackout windows, booking conflicts, and Gate A working-hours.
//
// Exposed as TWO functions, not one bundled call:
//
//   loadService({ tenantId, serviceId, isNightlyBooking, durationMinutes })
//     → loads service row + resolves duration + tenantCurrencyCode
//
//   checkAvailability({ tenantId, start, duration, staff_id, resource_id,
//                       serviceId, serviceMaxParallel, isNightlyBooking,
//                       isAdminBypass })
//     → blackout + conflict + Gate A
//
// The split exists for call-order interop with validate.validateStaffAndResource,
// which currently runs between service load and blackout/conflict (PR 2's
// commit explicitly promised "Call order preserved (runs after service load)
// so error-surface order is identical"). Bundling both into one call would
// force staff/resource validation to move before service load, which would
// change the error returned when both staffId AND serviceId are invalid.
// Both functions still serve one stated responsibility — "load service +
// verify availability" — so Rule 2 (responsibility test) is satisfied.
//
// Error pattern matches PR 2: returns { ok: true, ...data } or
// { ok: false, status, body }. The orchestrator maps { ok: false } to
// `res.status(status).json(body)` — a 1-to-1 swap for the inline
// `return res.status(...).json(...)` calls in the pre-extraction code.

const db = require('../../db');
const { checkConflicts } = require('../../utils/bookings');
const { getBookingPolicy, validateWithinWorkingHours } = require('../../utils/bookingPolicy');
const { checkBlackoutOverlap } = require('../../utils/bookingRouteHelpers');

// ─── loadService ────────────────────────────────────────────────────────────
// Resolves the service row from a `serviceId` plus the request's `isNightlyBooking`
// + `durationMinutes`. Uses forward-compatible column probes so older DBs
// missing `requires_confirmation` / `price_amount` / `price_per_night` /
// `tenants.currency_code` still work (defaults preserve pre-extraction
// behavior verbatim).
//
// Returns on success:
//   {
//     ok: true,
//     resolvedServiceId, duration, requiresConfirmation,
//     serviceDurationMinutes, servicePriceAmount, serviceMaxParallel,
//     tenantCurrencyCode,
//   }
// Returns { ok: false, status: 400, body: { error: 'Unknown serviceId for tenant.' } }
// when the service row is missing (matches pre-extraction status + body).
async function loadService({ tenantId, serviceId, isNightlyBooking, durationMinutes }) {
  const resolvedServiceId = serviceId ? Number(serviceId) : null;
  let duration = durationMinutes ? Number(durationMinutes) : null;
  let requiresConfirmation = false;
  let serviceDurationMinutes = null;
  let servicePriceAmount = null;
  let serviceMaxParallel = 1;
  let tenantCurrencyCode = null;

  if (resolvedServiceId) {
    // Service-level confirmation mode:
    // - requires_confirmation = true  -> bookings start as 'pending'
    // - requires_confirmation = false -> bookings start as 'confirmed'
    // Backwards compatibility: if the column doesn't exist yet, default to 'pending' (existing behavior).
    const hasReqConfRes = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='services' AND column_name='requires_confirmation'
       LIMIT 1`
    );
    const hasReqConf = hasReqConfRes.rowCount > 0;

    // Price columns are not consistent across older deployments.
    const priceCols = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='services'
         AND column_name IN ('price_amount','price','price_per_night')`
    );
    const hasPriceAmount   = priceCols.rows.some((r) => r.column_name === 'price_amount');
    const hasPriceLegacy   = priceCols.rows.some((r) => r.column_name === 'price');
    const hasPricePerNight = priceCols.rows.some((r) => r.column_name === 'price_per_night');
    const priceExpr = hasPriceAmount && hasPriceLegacy
      ? "COALESCE(price_amount, price) AS price_amount"
      : hasPriceAmount
        ? "price_amount AS price_amount"
        : hasPriceLegacy
          ? "price AS price_amount"
          : "NULL::numeric AS price_amount";

    // Tenant currency_code is used for dashboard display.
    const tenantCols = await db.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='tenants'
         AND column_name='currency_code'
       LIMIT 1`
    );
    if (tenantCols.rowCount > 0) {
      const tc = await db.query(`SELECT currency_code FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
      tenantCurrencyCode = tc.rows?.[0]?.currency_code || null;
    }

    const sRes = await db.query(
      `SELECT id, tenant_id, duration_minutes, max_parallel_bookings, ${priceExpr}${hasPricePerNight ? ", price_per_night" : ""}${hasReqConf ? ", COALESCE(requires_confirmation,false) AS requires_confirmation" : ""}
       FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [resolvedServiceId, tenantId]
    );
    if (!sRes.rows.length) {
      return { ok: false, status: 400, body: { error: 'Unknown serviceId for tenant.' } };
    }

    if (hasReqConf) {
      requiresConfirmation = !!sRes.rows[0].requires_confirmation;
    }

    serviceDurationMinutes = Number(sRes.rows[0].duration_minutes || 0) || null;
    // For nightly bookings prefer price_per_night (the per-night rate column)
    // over price_amount, which may store a legacy flat/session price.
    // This matches the rental availability engine which also prefers price_per_night.
    const rawPricePerNight = hasPricePerNight ? sRes.rows[0].price_per_night : null;
    const rawPriceAmount   = sRes.rows[0].price_amount;
    servicePriceAmount = isNightlyBooking && rawPricePerNight != null
      ? Number(rawPricePerNight)
      : (rawPriceAmount != null ? Number(rawPriceAmount) : null);

    if (!duration) {
      duration = Number(sRes.rows[0].duration_minutes || 60) || 60;
    }

    requiresConfirmation = hasReqConf ? !!sRes.rows[0].requires_confirmation : true;
    serviceMaxParallel = Number(sRes.rows[0].max_parallel_bookings) || 1;
  } else {
    duration = duration || 60;
  }

  return {
    ok: true,
    resolvedServiceId,
    duration,
    requiresConfirmation,
    serviceDurationMinutes,
    servicePriceAmount,
    serviceMaxParallel,
    tenantCurrencyCode,
  };
}

// ─── checkAvailability ──────────────────────────────────────────────────────
// Verifies the requested slot is bookable: tenant blackout windows do not
// overlap, no conflicting existing booking, and Gate A working-hours allow
// the start time. Nightly mode and admin bypass exempt Gate A (preserves
// the rental-suite behavior added April 2026).
//
// Returns { ok: true, bookingPolicy } on success — the orchestrator needs
// bookingPolicy.requireCharge later for Gate B (inside the transaction), so
// the policy object is exposed back to keep the pre-extraction single-load
// behavior (no extra DB round-trip). On failure, returns the same
// status/body the pre-extraction code would have returned via inline
// res.status(...).
async function checkAvailability({
  tenantId,
  start,
  duration,
  staff_id,
  resource_id,
  serviceId,
  serviceMaxParallel,
  isNightlyBooking,
  isAdminBypass,
}) {
  // Enforce blackout windows (closures) before running conflict checks.
  // This ensures that even if no bookings exist, closed windows remain unbookable.
  const end = new Date(start.getTime() + Number(duration) * 60 * 1000);
  const blackout = await checkBlackoutOverlap({
    tenantId,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    resourceId: resource_id,
    staffId: staff_id,
    serviceId,
  });
  if (blackout) {
    return {
      ok: false,
      status: 409,
      body: { error: 'This time window is blocked.', blackout },
    };
  }

  const conflicts = await checkConflicts({
    tenantId,
    staffId: staff_id,
    resourceId: resource_id,
    startTime: start.toISOString(),
    durationMinutes: duration,
    serviceId,
    maxParallel: serviceMaxParallel,
  });

  if (conflicts.conflict) {
    return {
      ok: false,
      status: 409,
      body: { error: 'Booking conflicts with an existing booking.', conflicts },
    };
  }

  // ─── PR 149: Gate A — working-hours validation ─────────────────────────
  // Resolve tenant timezone + policy, then re-check startTime against
  // tenant_hours for the LOCAL day-of-week in the tenant's zone. The
  // availability endpoint enforces this at slot-generation time, but
  // nothing was re-validating it on create — so a client could POST any
  // startTime and the server happily accepted it (see bug with BRD-TS-
  // 260420-0069, booked from Malaysia for 06:00 Asia/Amman while Birdie
  // opens at 10:00). Admin/owner bypass is exempt.
  //
  // NIGHTLY/RENTAL EXEMPTION (April 2026):
  // Nightly bookings span 24h+ windows (check-in today, check-out tomorrow
  // or later) and are not bound by the same desk-open business hours that
  // apply to time-slot services. A hotel room is "usable" around the clock
  // once handed over; whether the front-desk is staffed at 3 AM is a
  // separate operational question that should NOT block a reservation.
  // Skipping Gate A here preserves the Birdie bug-fix intent (time-slot
  // tenants still get working-hours enforcement on create) while letting
  // nightly tenants (aqababooking, etc.) accept bookings as designed.
  const bookingPolicy = await getBookingPolicy(tenantId);

  if (!isAdminBypass && !isNightlyBooking && bookingPolicy.enforceWorkingHours) {
    let tenantTzForPolicy = 'UTC';
    try {
      const tzRow = await db.query(
        `SELECT timezone FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );
      tenantTzForPolicy = tzRow.rows?.[0]?.timezone || 'UTC';
    } catch { /* fall through with UTC */ }

    const hoursCheck = await validateWithinWorkingHours({
      tenantId,
      tenantTz:        tenantTzForPolicy,
      startTime:       start.toISOString(),
      durationMinutes: duration,
    });

    if (!hoursCheck.ok) {
      return {
        ok: false,
        status: 422,
        body: {
          error:   hoursCheck.message,
          code:    hoursCheck.code,
          details: hoursCheck.details,
        },
      };
    }
  }
  // ─── End Gate A ────────────────────────────────────────────────────────

  return { ok: true, bookingPolicy };
}

module.exports = { loadService, checkAvailability };
