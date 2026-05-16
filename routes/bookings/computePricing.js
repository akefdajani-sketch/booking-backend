'use strict';

// routes/bookings/computePricing.js
//
// Post-BEGIN booking pricing pipeline for the booking creation engine.
// Extracted from routes/bookings/create.js (PR 4, Phase 1 refactor).
//
// Responsibility: given a resolved service + customer + membership/prepaid
// state, compute the booking's price_amount (with rate engine), charge_amount
// (zero if covered by membership/prepaid), Gate B require-charge enforcement,
// and the tax breakdown.
//
// Transaction posture: this module runs INSIDE the BEGIN…COMMIT transaction
// but is intentionally transaction-agnostic. It performs pool reads
// (db.query) for the rate engine's customer-membership-plan-IDs and
// customer-prepaid-product-IDs lookups, and calls utility engines
// (computeRateForBookingLike, computeTaxForBooking) that don't touch the
// transaction client. On Gate B failure, the module returns
// { ok: false, status: 422, body } and the ORCHESTRATOR is responsible for
// calling `await client.query("ROLLBACK")` before responding — matching the
// existing post-BEGIN failure pattern in create.js (see the ROLLBACK-then-
// respond convention used by the membership and prepaid blocks).
//
// Error pattern: { ok: true, ...data } | { ok: false, status, body } returns
// (same as PRs 2 and 3). Throws are intentionally avoided — they'd route
// through the outer catch and turn 422s into 500s.

const db = require('../../db');
const { computeRateForBookingLike } = require('../../utils/ratesEngine');
const { computeTaxForBooking } = require('../../utils/taxEngine');
const { validateRequireCharge } = require('../../utils/bookingPolicy');

async function computePricing({
  tenantId,
  serviceId,
  staffId,
  resourceId,
  start,
  duration,
  isNightlyBooking,
  nights_count,
  checkin_date,
  checkout_date,
  servicePriceAmount,
  serviceDurationMinutes,
  finalCustomerId,
  finalCustomerMembershipId,
  prepaidApplied,
  isAdminBypass,
  bookingPolicy,
}) {
  // Compute price + charge amounts.
  // - price_amount represents the booking's list price/value.
  // - charge_amount is what we actually charge (0 if covered by membership).
  //
  // NIGHTLY bookings: price = price_per_night × nights_count.
  // duration_minutes is a timeslot concept and must NOT be used for nightly
  // pricing — tenants set a nightly rate and should never need to touch
  // duration_minutes to get a correct total.
  //
  // TIMESLOT bookings: scale proportionally when the booked duration differs
  // from the service's base duration (e.g. a 90-min session on a 60-min service).
  let price_amount = null;
  if (servicePriceAmount != null && Number.isFinite(servicePriceAmount)) {
    const base = Number(servicePriceAmount);

    if (isNightlyBooking) {
      // Nightly: flat rate × nights. nights_count is sent by the frontend
      // and also derived from checkin/checkout dates as a fallback.
      const n = Number(nights_count) ||
        (checkin_date && checkout_date
          ? Math.round(
              (new Date(`${checkout_date}T00:00:00Z`) - new Date(`${checkin_date}T00:00:00Z`))
              / 86400000
            )
          : 1);
      price_amount = Math.round(base * Math.max(n, 1) * 100) / 100;
    } else {
      // Timeslot: proportional scaling when booked duration ≠ service duration.
      const svcDur = Number(serviceDurationMinutes || duration || 0);
      const dur = Number(duration || 0);
      if (svcDur > 0 && dur > 0 && dur !== svcDur) {
        price_amount = Math.round((base * (dur / svcDur)) * 100) / 100;
      } else {
        price_amount = Math.round(base * 100) / 100;
      }
    }
  }

  // Apply dynamic Rates rules (if configured).
  // Non-fatal: if rate_rules table is not present yet, bookings still succeed.
  //
  // FIX: Always call the rates engine regardless of whether the service has
  // a base price. Fixed-price rate rules set the price directly and do not
  // require a base price. Previously, services with rate rules but no base
  // price (e.g. Golf Simulator) would never have rates applied to bookings.
  let applied_rate_rule_id = null;
  let applied_rate_snapshot = null;
  try {
    if (serviceId) {
      // Resolve the customer's active membership plan IDs and prepaid product IDs
      // so membership/package-scoped rate rules fire correctly.
      // These queries are lightweight (indexed on customer_id + status) and non-fatal.
      let customerMembershipPlanIds = null;
      let customerPrepaidProductIds = null;
      if (finalCustomerId) {
        try {
          const [memQ, prepQ] = await Promise.all([
            db.query(
              `SELECT DISTINCT plan_id
               FROM customer_memberships
               WHERE customer_id = $1
                 AND COALESCE(status, 'active') = 'active'
                 AND (expires_at IS NULL OR expires_at > NOW())`,
              [finalCustomerId]
            ),
            db.query(
              `SELECT DISTINCT prepaid_product_id
               FROM customer_prepaid_entitlements
               WHERE customer_id = $1
                 AND COALESCE(status, 'active') = 'active'
                 AND COALESCE(remaining_quantity, 0) > 0
                 AND (expires_at IS NULL OR expires_at > NOW())`,
              [finalCustomerId]
            ),
          ]);
          customerMembershipPlanIds = memQ.rows.map((r) => Number(r.plan_id));
          customerPrepaidProductIds = prepQ.rows.map((r) => Number(r.prepaid_product_id));
        } catch (_e) {
          // Non-fatal: if these queries fail, fall back to anonymous pricing
        }
      }

      const computed = await computeRateForBookingLike({
        tenantId,
        serviceId,
        staffId,
        resourceId,
        start,
        durationMinutes: Number(duration),
        basePriceAmount: price_amount != null ? Number(price_amount) : null,
        // NIGHTLY: one pricing unit = 1 night = 1440 minutes.
        // Using serviceDurationMinutes (e.g. 10 min) here would create
        // hundreds of artificial slots and multiply the rate wrongly.
        // Timeslot bookings continue to use the service's slot duration.
        serviceSlotMinutes: isNightlyBooking
          ? 1440
          : (Number(serviceDurationMinutes) || Number(duration)),
        customerMembershipPlanIds,
        customerPrepaidProductIds,
      });
      if (computed && computed.adjusted_price_amount != null) {
        price_amount = Number(computed.adjusted_price_amount);
      }
      applied_rate_rule_id = computed?.applied_rate_rule_id ?? null;
      applied_rate_snapshot = computed?.applied_rate_snapshot ?? null;
    }
  } catch (e) {
    console.warn("ratesEngine non-fatal error (booking create):", e?.message || e);
  }

  const charge_amount = (finalCustomerMembershipId || prepaidApplied) ? 0 : price_amount;

  // ─── PR 149: Gate B — require-charge validation ─────────────────────
  // For tenants who've opted into requireCharge (e.g., Birdie), reject
  // any booking where no rate rule matched and the service has no base
  // price — price_amount ends up null, charge_amount ends up null, and
  // the later payment_method derivation silently downgrades to 'free'.
  // Membership/prepaid-covered bookings are exempt (they legitimately
  // go to 0 via a different path).
  //
  // Defaults off (requireCharge=false in DEFAULT_POLICY). Birdie opts in
  // via:  UPDATE tenants SET branding = jsonb_set(
  //         COALESCE(branding, '{}'::jsonb),
  //         '{booking_policy,require_charge}', 'true'
  //       ) WHERE slug = 'birdie-golf';
  //
  // ROLLBACK responsibility: the orchestrator handles `client.query("ROLLBACK")`
  // before responding with this { ok: false } payload. Keeping this module
  // transaction-agnostic mirrors the post-BEGIN failure convention in create.js.
  if (!isAdminBypass && bookingPolicy.requireCharge) {
    const chargeCheck = validateRequireCharge({
      priceAmount:               price_amount,
      finalCustomerMembershipId,
      prepaidApplied,
      serviceId,
    });
    if (!chargeCheck.ok) {
      return {
        ok: false,
        status: 422,
        body: {
          error:   chargeCheck.message,
          code:    chargeCheck.code,
          details: chargeCheck.details,
        },
      };
    }
  }
  // ─── End Gate B ─────────────────────────────────────────────────────

  // PR-TAX-1: Compute tax breakdown (non-fatal — never blocks booking creation)
  let taxData = { subtotal_amount: null, vat_amount: null, service_charge_amount: null, total_amount: null, tax_snapshot: null };
  const taxableAmount = charge_amount;
  if (taxableAmount != null && Number.isFinite(taxableAmount) && taxableAmount > 0) {
    try {
      const taxResult = await computeTaxForBooking({ tenantId, serviceId, chargedAmount: taxableAmount });
      taxData = { subtotal_amount: taxResult.subtotal, vat_amount: taxResult.vat_amount, service_charge_amount: taxResult.service_charge_amount, total_amount: taxResult.total, tax_snapshot: taxResult.snapshot };
    } catch (taxErr) {
      console.warn("taxEngine non-fatal error (booking create):", taxErr?.message || taxErr);
    }
  }

  return {
    ok: true,
    price_amount,
    charge_amount,
    applied_rate_rule_id,
    applied_rate_snapshot,
    taxData,
  };
}

module.exports = computePricing;
