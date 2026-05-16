'use strict';

// routes/bookings/persist.js
//
// Post-entitlement, in-transaction booking persistence. PR 6, Phase 1
// refactor. Pairs with applyEntitlementWrites.js.
//
// persistBooking(client, ctx) →
//   { ok: true, bookingId, created } | { ok: false, status, body }
// On failure, ROLLBACK is already done inside (matches PR 5 convention).
// created=false on idempotency replay (23505 → SELECT existing).
//
// ROLLBACK paths (2): session full (409); 23P01 exclusion (409, two
// message bodies by serviceMaxParallel).

const db = require('../../db');
const { ensureBookingMoneyColumns } = require('../../utils/ensureBookingMoneyColumns');
const { ensureBookingRateColumns } = require('../../utils/ensureBookingRateColumns');
const { ensurePaymentMethodColumn } = require('../../utils/ensurePaymentMethodColumn');
const { findOrCreateSession, incrementSessionCount } = require('../../utils/bookings');

// ─── derivePayment ──────────────────────────────────────────────────────────
// PAY-INTENT-1 + CLIQ-CONFIRM-1 ternaries preserved verbatim. method is
// INTENT (membership/package/free/cash/card/cliq/null); status is the
// actual money state (completed/pending/null).
function derivePayment(ctx) {
  const {
    finalCustomerMembershipId, prepaidApplied,
    price_amount, requestedPaymentMethod, networkPaymentOrderId,
  } = ctx;

  // PAY-INTENT-1: trust client-declared method for card/cliq without
  // requiring an MPGS order ID up-front (CliQ never has one).
  const payment_method = finalCustomerMembershipId
    ? 'membership'
    : prepaidApplied
      ? 'package'
      : (price_amount == null || price_amount === 0)
        ? 'free'
        : requestedPaymentMethod === 'cash'
          ? 'cash'
          : (requestedPaymentMethod === 'card' || requestedPaymentMethod === 'cliq')
            ? requestedPaymentMethod
            : null;

  // CLIQ-CONFIRM-1: completed for auto-settled methods + verified card;
  // pending for card-without-order-id and cliq (waiting for operator).
  const payment_status =
    payment_method == null ? null
    : (payment_method === 'membership' ||
       payment_method === 'package' ||
       payment_method === 'free' ||
       payment_method === 'cash')
      ? 'completed'
      : (payment_method === 'card' && networkPaymentOrderId)
        ? 'completed'
        : (payment_method === 'card' || payment_method === 'cliq')
          ? 'pending'
          : null;

  return { payment_method, payment_status };
}

// ─── probeBookingColumns ───────────────────────────────────────────────────
// Forward-compat column probes. Three helper calls + two inline reads
// (payment_status from migration 064, tax columns from migration 031).
async function probeBookingColumns() {
  const hasMoneyCols = await ensureBookingMoneyColumns();
  const hasRateCols = await ensureBookingRateColumns();
  const hasPaymentMethodCol = await ensurePaymentMethodColumn(); // PAY-2

  // CLIQ-CONFIRM-1: defensive check for payment_status column (migration 064)
  const hasPaymentStatusCol = await (async () => {
    try {
      const r = await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bookings'
            AND column_name='payment_status'`
      );
      return r.rows.length > 0;
    } catch (_) { return false; }
  })();

  // PR-TAX-1: detect tax columns (migration 031 guard — safe on old DBs)
  const hasTaxCols = await (async () => {
    try {
      const r = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bookings'
            AND column_name IN ('subtotal_amount','vat_amount','service_charge_amount','total_amount','tax_snapshot')`,
        []
      );
      return r.rows.length >= 5;
    } catch (_) { return false; }
  })();

  return { hasMoneyCols, hasRateCols, hasPaymentMethodCol, hasPaymentStatusCol, hasTaxCols };
}

// ─── findOrCreateSessionFlow ───────────────────────────────────────────────
// Session handling for parallel services. If max_parallel_bookings > 1,
// find or create a session and check capacity. Confirmed_count increment
// is atomic with the booking INSERT (lives in insertBookingRow below).
async function findOrCreateSessionFlow(client, ctx) {
  const { serviceMaxParallel, resolvedServiceId, tenantId, resource_id, staff_id, start, duration } = ctx;

  if (!(serviceMaxParallel > 1 && resolvedServiceId)) {
    return { ok: true, sessionId: null };
  }

  const sessionResult = await findOrCreateSession({
    client,
    tenantId,
    serviceId: resolvedServiceId,
    resourceId: resource_id,
    staffId: staff_id,
    startTimeIso: start.toISOString(),
    durationMinutes: duration,
    maxCapacity: serviceMaxParallel,
  });

  if (sessionResult.full) {
    await client.query("ROLLBACK");
    return {
      ok: false,
      status: 409,
      body: {
        error: "This session is full. No spots remaining.",
        spotsRemaining: 0,
      },
    };
  }

  return { ok: true, sessionId: sessionResult.sessionId };
}

// Build $1, $2, $3... placeholder list for parameterized SQL.
function makePlaceholders(params) {
  return params.map((_, i) => `$${i + 1}`).join(', ');
}

// ─── insertBookingRow ──────────────────────────────────────────────────────
// The main INSERT. 4-branch SQL builder based on column probe results,
// followed by PAY-FIX network_payment linkage + session count increment.
// Catches 23505 (idempotency replay) and 23P01 (exclusion constraint).
async function insertBookingRow(client, ctx, payment, cols, resolvedSessionId) {
  const {
    tenantId, resolvedServiceId, staff_id, resource_id,
    start, duration, finalCustomerId, cleanName, cleanPhone, cleanEmail,
    initialStatus, idemKey, finalCustomerMembershipId,
    isNightlyBooking, checkin_date, checkout_date, nights_count,
    incomingAddonsJson, incomingGuestsCount,
    tenantCurrencyCode, networkPaymentOrderId,
    price_amount, charge_amount, applied_rate_rule_id, applied_rate_snapshot, taxData,
    serviceMaxParallel,
  } = ctx;
  const { payment_method, payment_status } = payment;
  const { hasMoneyCols, hasRateCols, hasPaymentMethodCol, hasPaymentStatusCol, hasTaxCols } = cols;

  // PAY-2: include payment_method only if column exists (defensive — see ensurePaymentMethodColumn)
  // RENTAL-1: check if nightly columns exist (added by migration 023)
  const bookingCols = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='bookings' AND column_name IN ('booking_mode','checkin_date','checkout_date','nights_count','addons_json','guests_count','addons_total')`,
  ).then(r => new Set(r.rows.map(x => x.column_name))).catch(() => new Set());
  const hasNightlyCols = bookingCols.has('booking_mode') && bookingCols.has('checkin_date');
  const hasAddonsCols  = bookingCols.has('addons_json') && bookingCols.has('guests_count');

  // Parse and validate incoming add-ons
  let parsedAddons = null;
  let addonsTotal  = 0;
  if (isNightlyBooking && incomingAddonsJson && hasAddonsCols) {
    try {
      parsedAddons = typeof incomingAddonsJson === 'string'
        ? JSON.parse(incomingAddonsJson)
        : incomingAddonsJson;
      if (Array.isArray(parsedAddons)) {
        addonsTotal = parsedAddons.reduce((sum, a) => sum + (Number(a.subtotal) || 0), 0);
      }
    } catch { parsedAddons = null; }
  }
  const guestsCount = incomingGuestsCount ? Math.max(1, Number(incomingGuestsCount)) : 1;

  let extraCols = hasPaymentMethodCol ? ', payment_method' : '';
  // CLIQ-CONFIRM-1: payment_status column added by migration 064
  if (hasPaymentStatusCol) extraCols += ', payment_status';
  if (isNightlyBooking && hasNightlyCols) {
    extraCols += ', booking_mode, checkin_date, checkout_date, nights_count';
  }
  if (isNightlyBooking && hasAddonsCols) {
    extraCols += ', addons_json, guests_count, addons_total';
  }

  const baseCols = `tenant_id, service_id, staff_id, resource_id, start_time, duration_minutes,
       customer_id, customer_name, customer_phone, customer_email, status, idempotency_key, customer_membership_id, session_id${extraCols}`;

  let baseVals = [tenantId, resolvedServiceId, staff_id, resource_id,
       start.toISOString(), duration,
       finalCustomerId, cleanName, cleanPhone, cleanEmail,
       initialStatus, idemKey, finalCustomerMembershipId, resolvedSessionId];
  if (hasPaymentMethodCol) baseVals.push(payment_method);
  if (hasPaymentStatusCol) baseVals.push(payment_status); // CLIQ-CONFIRM-1
  if (isNightlyBooking && hasNightlyCols) {
    baseVals.push('nightly');
    baseVals.push(checkin_date || null);
    baseVals.push(checkout_date || null);
    baseVals.push(nights_count ? Number(nights_count) : null);
  }
  if (isNightlyBooking && hasAddonsCols) {
    baseVals.push(parsedAddons ? JSON.stringify(parsedAddons) : null);
    baseVals.push(guestsCount);
    baseVals.push(addonsTotal);
  }

  let insertSql;
  let insertParams = baseVals;

  if (hasMoneyCols && hasRateCols && hasTaxCols) {
    // PR-TAX-1: full tax columns available
    insertParams = [
      ...baseVals,
      price_amount, charge_amount, tenantCurrencyCode,
      applied_rate_rule_id, applied_rate_snapshot,
      taxData.subtotal_amount, taxData.vat_amount,
      taxData.service_charge_amount, taxData.total_amount,
      taxData.tax_snapshot ? JSON.stringify(taxData.tax_snapshot) : null,
    ];
    insertSql = `
    INSERT INTO bookings
      (${baseCols}, price_amount, charge_amount, currency_code,
       applied_rate_rule_id, applied_rate_snapshot,
       subtotal_amount, vat_amount, service_charge_amount, total_amount, tax_snapshot)
    VALUES
      (${makePlaceholders(insertParams)})
    RETURNING id;
    `;
  } else if (hasMoneyCols && hasRateCols) {
    insertParams = [...baseVals, price_amount, charge_amount, tenantCurrencyCode, applied_rate_rule_id, applied_rate_snapshot];
    insertSql = `
    INSERT INTO bookings
      (${baseCols}, price_amount, charge_amount, currency_code, applied_rate_rule_id, applied_rate_snapshot)
    VALUES
      (${makePlaceholders(insertParams)})
    RETURNING id;
    `;
  } else if (hasMoneyCols) {
    insertParams = [...baseVals, price_amount, charge_amount, tenantCurrencyCode];
    insertSql = `
    INSERT INTO bookings
      (${baseCols}, price_amount, charge_amount, currency_code)
    VALUES
      (${makePlaceholders(insertParams)})
    RETURNING id;
    `;
  } else {
    insertParams = baseVals;
    insertSql = `
    INSERT INTO bookings
      (${baseCols})
    VALUES
      (${makePlaceholders(insertParams)})
    RETURNING id;
    `;
  }

  let bookingId;
  let created = true;

  try {
    const insert = await client.query(insertSql, insertParams);
    bookingId = insert.rows[0].id;

    // PAY-FIX: link this booking back to the MPGS payment record.
    // Non-fatal — if linkage fails the booking still exists.
    if (networkPaymentOrderId && bookingId) {
      try {
        await client.query(
          `UPDATE network_payments
             SET booking_id  = $1,
                 updated_at  = NOW()
           WHERE order_id  = $2
             AND tenant_id = $3`,
          [bookingId, String(networkPaymentOrderId).trim(), tenantId]
        );
      } catch (linkErr) {
        console.warn('[PAY] Could not link network_payment to booking:', linkErr?.message);
      }
    }

    // Increment session confirmed_count atomically with the booking INSERT
    if (resolvedSessionId) {
      await incrementSessionCount({
        client,
        sessionId: resolvedSessionId,
        maxCapacity: serviceMaxParallel,
      });
    }
  } catch (err) {
    if (idemKey && err && err.code === "23505") {
      // Idempotency replay: same key used before — return the existing booking.
      const existing = await client.query(
        `SELECT id FROM bookings WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1`,
        [tenantId, idemKey]
      );
      if (existing.rows.length) {
        bookingId = existing.rows[0].id;
        created = false;
      } else {
        throw err;
      }
    } else if (err && err.code === "23P01") {
      // Exclusion constraint violation. For parallel services this fires on
      // the 2nd+ participant despite session capacity (false conflict, fix is
      // migration 012); for single-capacity it's a genuine race. 409 either way.
      await client.query("ROLLBACK");
      if (serviceMaxParallel > 1) {
        return {
          ok: false,
          status: 409,
          body: {
            error:
              "A database constraint is blocking this parallel booking. " +
              "Please ask your administrator to run migration " +
              "012_drop_booking_range_exclude.sql on the production database.",
            code: "PARALLEL_BOOKING_CONSTRAINT",
          },
        };
      }
      return {
        ok: false,
        status: 409,
        body: {
          error: "Booking conflicts with an existing booking (resource overlap).",
          code: "RESOURCE_CONFLICT",
        },
      };
    } else {
      throw err;
    }
  }

  return { ok: true, bookingId, created };
}

// ─── generateBookingCode ──────────────────────────────────────────────────
// Format: {PREFIX}-{TYPE}-{YYMMDD}-{SEQ4} (e.g. BRD-TS-260226-0079).
// PREFIX from tenants.booking_code_prefix (fallback: slug). TYPE=TS|NT.
// SEQ4 = per-tenant counter (atomic UPDATE tenants RETURNING booking_seq).
// Non-fatal fallback (legacy format) if any step throws.
async function generateBookingCode(client, ctx, bookingId) {
  const { tenantId, isNightlyBooking, checkin_date, start, resolvedStartTime, resolvedServiceId, cleanName } = ctx;

  let bookingCode;
  try {
    const seqResult = await client.query(
      `UPDATE tenants
         SET booking_seq = booking_seq + 1
       WHERE id = $1
       RETURNING booking_seq, booking_code_prefix, slug`,
      [tenantId]
    );
    const seqRow = seqResult.rows[0];
    const seq    = seqRow?.booking_seq ?? 1;

    const rawPrefix  = (seqRow?.booking_code_prefix || "").trim().toUpperCase();
    const slugPrefix = (seqRow?.slug || "BKG").replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase();
    const prefix     = rawPrefix || slugPrefix;

    const bookingType = isNightlyBooking ? "NT" : "TS";

    let dateStr;
    if (isNightlyBooking && checkin_date) {
      dateStr = String(checkin_date).replace(/-/g, "").slice(2);
    } else {
      const startDate = start instanceof Date ? start : new Date(resolvedStartTime);
      dateStr = startDate.toISOString().slice(0, 10).replace(/-/g, "").slice(2);
    }

    const seqStr  = String(seq).padStart(4, "0");
    bookingCode   = `${prefix}-${bookingType}-${dateStr}-${seqStr}`;
  } catch (codeErr) {
    // Non-fatal fallback — never fail a booking over a code generation error
    console.warn("Booking code generation failed (non-fatal), using legacy format:", codeErr?.message);
    const firstLetter = cleanName.charAt(0).toUpperCase() || "X";
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    bookingCode = `${firstLetter}-${tenantId}-${resolvedServiceId || 0}-${ymd}-${bookingId}`;
  }

  await client.query(
    `UPDATE bookings
       SET booking_code = COALESCE(booking_code, $1)
     WHERE id = $2 AND tenant_id = $3`,
    [bookingCode, bookingId, tenantId]
  );
}

// ─── persistBooking (public entry point) ──────────────────────────────────
async function persistBooking(client, ctx) {
  const payment = derivePayment(ctx);
  const cols = await probeBookingColumns();

  const sessionResult = await findOrCreateSessionFlow(client, ctx);
  if (!sessionResult.ok) return sessionResult;

  const insertResult = await insertBookingRow(client, ctx, payment, cols, sessionResult.sessionId);
  if (!insertResult.ok) return insertResult;
  const { bookingId, created } = insertResult;

  await generateBookingCode(client, ctx, bookingId);

  return { ok: true, bookingId, created };
}

module.exports = persistBooking;
