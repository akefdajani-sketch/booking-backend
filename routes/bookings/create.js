// routes/bookings/create.js
// POST / (booking creation engine)
// Mounted by routes/bookings.js

const db = require("../../db");
const { pool } = require("../../db");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const { ensureBookingMoneyColumns } = require("../../utils/ensureBookingMoneyColumns");
const { parseBookingListParams, buildBookingListWhere } = require("../../utils/bookingQueryBuilder");
const { decrementSessionCount, loadJoinedBookingById } = require("../../utils/bookings");
const {
  shouldUseCustomerHistory, servicesHasColumn,
  getIdempotencyKey, mustHaveTenantSlug, canTransitionStatus, bumpTenantBookingChange,
  roundUpMinutes,
} = require("../../utils/bookingRouteHelpers");
// VOICE-PERF-1: Bust the customer's AI context cache after a booking lands
// so subsequent voice/chat turns see updated balance + the new booking in
// recent history.
const aiContextCache = require("../../utils/aiContextCache");
// PR 1 (Phase 1 refactor): post-COMMIT WA/SMS/email dispatch + AI cache bust.
const dispatchNotifications = require("./dispatchNotifications");
// PR 2 (Phase 1 refactor): pre-BEGIN input validation + customer resolution.
const validate = require("./validate");
const resolveCustomer = require("./resolveCustomer");
// PR 3 (Phase 1 refactor): pre-BEGIN service load + availability checks.
const { loadService, checkAvailability } = require("./resolveAvailability");
// PR 4 (Phase 1 refactor): post-BEGIN pricing pipeline (rate + charge + Gate B + tax).
const computePricing = require("./computePricing");
// PR 5 (Phase 1 refactor): post-BEGIN membership consumption + prepaid resolution.
const { resolveMembership, resolvePrepaid } = require("./resolveEntitlement");
// PR 6 (Phase 1 refactor): post-pricing, in-transaction persistence (booking
// row + booking_code + sessions + entitlement bookkeeping).
const persistBooking = require("./persist");
const applyEntitlementWrites = require("./applyEntitlementWrites");


module.exports = function mount(router) {
router.post("/", requireAppAuth, requireTenant, async (req, res) => {
  try {
    // Ensure revenue/price columns exist in older DBs.
    // (No-op if already applied.)
    await ensureBookingMoneyColumns();

    // PR 2 (Phase 1 refactor): pre-BEGIN input parsing + auth + raw startTime
    // presence check extracted to validate.parseInputs. The startTime
    // presence check stays here-first (before resolveCustomer) so a
    // missing-startTime request never creates a customer row.
    const parsed = validate.parseInputs(req);
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
    const {
      serviceId,
      startTime,
      durationMinutes,
      customerName,
      customerPhone,
      staffId,
      resourceId,
      customerMembershipId,
      autoConsumeMembership,
      requireMembership,
      prepaidEntitlementId,
      autoConsumePrepaid,
      requirePrepaid,
      requestedPaymentMethod,
      networkPaymentOrderId,
      incomingBookingMode,
      checkin_date,
      checkout_date,
      nights_count,
      incomingAddonsJson,
      incomingGuestsCount,
      slug,
      resolvedTenantId,
      isAdminBypass,
      googleEmail,
      googleName,
      requestedCustomerEmail,
    } = parsed;

    const idemKey = getIdempotencyKey(req);

    // PR 2 (Phase 1 refactor): require-phone tenant policy lookup + customer
    // resolution (SELECT-or-INSERT) extracted. Policy is loaded BEFORE
    // resolveCustomer (matches pre-extraction call order); enforcement of
    // require-phone still happens below, after the customer record is in
    // hand so finalCustomerPhone reflects the stored value when present.
    const requirePhone = await validate.loadRequirePhonePolicy(resolvedTenantId);

    // Resolve or create customer for this tenant.
    // - Public booking: customer identity comes from Google.
    // - Staff/admin booking (owner proxy): customer identity comes from request payload.
    // IMPORTANT: we NEVER trust customerId from the client for authenticated flows.
    const initialCustomerName = isAdminBypass
      ? String(customerName || "").trim()
      : (googleName || "").trim();
    const customerResult = await resolveCustomer({
      tenantId: resolvedTenantId,
      email: requestedCustomerEmail,
      name: initialCustomerName,
      phone: customerPhone,
      isAdminBypass,
    });
    if (!customerResult.ok) return res.status(customerResult.status).json(customerResult.body);
    const {
      id: finalCustomerId,
      name: finalCustomerName,
      phone: finalCustomerPhone,
      email: finalCustomerEmail,
    } = customerResult.customer;

    if (requirePhone && !String(finalCustomerPhone || "").trim()) {
      return res.status(409).json({
        error: "Phone number required before booking.",
        code: "PROFILE_INCOMPLETE",
        fields: ["phone"],
      });
    }

    // PR 2 (Phase 1 refactor): nightly-mode startTime derivation +
    // invalid-date + past-check extracted to validate.deriveStartTime.
    const startResult = validate.deriveStartTime({
      startTime,
      checkin_date,
      incomingBookingMode,
    });
    if (!startResult.ok) return res.status(startResult.status).json(startResult.body);
    const { resolvedStartTime, start, isNightlyBooking } = startResult;

    // PR 3 (Phase 1 refactor): service load + column probes extracted to
    // resolveAvailability.loadService. Same SQL, same defaults, same
    // "Unknown serviceId for tenant" error shape.
    const svcResult = await loadService({
      tenantId: resolvedTenantId,
      serviceId,
      isNightlyBooking,
      durationMinutes,
    });
    if (!svcResult.ok) return res.status(svcResult.status).json(svcResult.body);
    const {
      resolvedServiceId,
      duration,
      requiresConfirmation,
      serviceDurationMinutes,
      servicePriceAmount,
      serviceMaxParallel,
      tenantCurrencyCode,
    } = svcResult;

    const bookingStatus = requiresConfirmation ? "pending" : "confirmed";

    // PR 2 (Phase 1 refactor): staff/resource parse + per-tenant existence
    // checks extracted to validate.validateStaffAndResource. Call order
    // preserved (runs after service load) so error-surface order is identical.
    const staffResult = await validate.validateStaffAndResource({
      staffId,
      resourceId,
      tenantId: resolvedTenantId,
    });
    if (!staffResult.ok) return res.status(staffResult.status).json(staffResult.body);
    const { staff_id, resource_id } = staffResult;

    // PR 3 (Phase 1 refactor): blackout + conflict + Gate A working-hours
    // extracted to resolveAvailability.checkAvailability. Call order
    // preserved (runs after validate.validateStaffAndResource so
    // staff_id/resource_id are available; Gate A's nightly + admin
    // bypass logic is verbatim).
    const availResult = await checkAvailability({
      tenantId: resolvedTenantId,
      start,
      duration,
      staff_id,
      resource_id,
      serviceId: resolvedServiceId,
      serviceMaxParallel,
      isNightlyBooking,
      isAdminBypass,
    });
    if (!availResult.ok) return res.status(availResult.status).json(availResult.body);
    const { bookingPolicy } = availResult;

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Customer is already resolved (authenticated) before the transaction.
      // Keep local aliases for downstream logic / inserts.
      const cleanName = String(finalCustomerName || "Customer").trim();
      const cleanPhone = finalCustomerPhone ? String(finalCustomerPhone).trim() : null;
      const cleanEmail = finalCustomerEmail ? String(finalCustomerEmail).trim() : null;


      // PR 5 (Phase 1 refactor): post-BEGIN membership consumption + prepaid
      // resolution extracted to routes/bookings/resolveEntitlement.js. Two
      // functions; each takes the transaction client and owns its own
      // ROLLBACK on failure (14 ROLLBACKs in the inventory; mapping in the
      // PR 5 description). Back-edges (debitMinutes, debitUses,
      // membershipBefore, membershipPolicy) flow back to this orchestrator
      // for the post-INSERT ledger-write block below; PR 6 will absorb that
      // block, at which point the back-edges become module-internal.
      const memResult = await resolveMembership(client, {
        tenantId: resolvedTenantId,
        serviceId,
        finalCustomerId,
        customerMembershipId,
        autoConsumeMembership,
        requireMembership,
        duration,
      });
      if (!memResult.ok) return res.status(memResult.status).json(memResult.body);
      const {
        finalCustomerMembershipId,
        debitMinutes,
        debitUses,
        membershipBefore,
        membershipPolicy,
      } = memResult;

      const prepaidResult = await resolvePrepaid(client, {
        tenantId: resolvedTenantId,
        resolvedServiceId,
        finalCustomerId,
        duration,
        serviceDurationMinutes,
        prepaidEntitlementId,
        autoConsumePrepaid,
        requirePrepaid,
      });
      if (!prepaidResult.ok) return res.status(prepaidResult.status).json(prepaidResult.body);
      const { prepaidApplied } = prepaidResult;

      // Insert booking (idempotent)
      const initialStatus = requiresConfirmation ? "pending" : "confirmed";

      // PR 4 (Phase 1 refactor): pricing pipeline (price + rate engine + charge
      // + Gate B + tax) extracted to computePricing. Pool-only module; this
      // orchestrator owns the ROLLBACK on Gate B failure to match the
      // post-BEGIN failure convention used elsewhere in this transaction.
      const pricingResult = await computePricing({
        tenantId: resolvedTenantId,
        serviceId: resolvedServiceId,
        staffId: staff_id,
        resourceId: resource_id,
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
      });
      if (!pricingResult.ok) {
        await client.query("ROLLBACK");
        return res.status(pricingResult.status).json(pricingResult.body);
      }
      const {
        price_amount,
        charge_amount,
        applied_rate_rule_id,
        applied_rate_snapshot,
        taxData,
      } = pricingResult;

      // PR 6 (Phase 1 refactor): post-pricing, in-transaction persistence
      // extracted to two modules:
      //   - persist.js              → payment derivation + column probes +
      //                                session find/create + booking INSERT
      //                                + booking code generation
      //   - applyEntitlementWrites.js → membership ledger debit + balance
      //                                  UPDATE + prepaid redemption writes
      // Each module owns its own ROLLBACK on failure. The 4 PR 5 back-edges
      // (debitMinutes, debitUses, membershipBefore, membershipPolicy) are
      // now module-internal — passed through the orchestrator into the
      // entitlement writes ctx, but no orchestrator code post-COMMIT reads
      // them.
      const persistResult = await persistBooking(client, {
        tenantId: resolvedTenantId,
        resolvedServiceId,
        staff_id,
        resource_id,
        start,
        duration,
        finalCustomerId,
        cleanName,
        cleanPhone,
        cleanEmail,
        initialStatus,
        idemKey,
        isNightlyBooking,
        checkin_date,
        checkout_date,
        nights_count,
        resolvedStartTime,
        incomingAddonsJson,
        incomingGuestsCount,
        serviceMaxParallel,
        tenantCurrencyCode,
        requestedPaymentMethod,
        networkPaymentOrderId,
        finalCustomerMembershipId,
        prepaidApplied,
        price_amount,
        charge_amount,
        applied_rate_rule_id,
        applied_rate_snapshot,
        taxData,
      });
      if (!persistResult.ok) return res.status(persistResult.status).json(persistResult.body);
      const { bookingId, created } = persistResult;

      const entitlementResult = await applyEntitlementWrites(
        client,
        {
          tenantId: resolvedTenantId,
          finalCustomerId,
          finalCustomerMembershipId,
          debitMinutes,
          debitUses,
          membershipBefore,
          membershipPolicy,
          prepaidApplied,
        },
        bookingId,
        created
      );
      if (!entitlementResult.ok) return res.status(entitlementResult.status).json(entitlementResult.body);
      // prepaidApplied was mutated in place by applyEntitlementWrites
      // (redemptionId + remainingQuantity from RETURNING). entitlementResult
      // returns the same reference for boundary visibility.

      await client.query("COMMIT");

      // 🔥 This is the critical bump used by heartbeat + UI refresh
      await bumpTenantBookingChange(resolvedTenantId);

      const joined = await loadJoinedBookingById(bookingId, resolvedTenantId);
      if (joined && prepaidApplied) {
        joined.prepaid_applied = true;
        joined.prepaid_entitlement_id = prepaidApplied.entitlementId;
        joined.prepaid_product_id = prepaidApplied.prepaidProductId;
        joined.prepaid_product_name = prepaidApplied.prepaidProductName;
        joined.prepaid_redemption_id = prepaidApplied.redemptionId || null;
        joined.prepaid_redemption_mode = prepaidApplied.redemptionMode;
        joined.prepaid_quantity_used = prepaidApplied.redeemedQuantity;
        joined.prepaid_quantity_remaining = prepaidApplied.remainingQuantity ?? null;
      }

      // PR 1 (Phase 1 refactor): post-COMMIT WA/SMS/email dispatch + AI cache
      // bust extracted to routes/bookings/dispatchNotifications.js. All four
      // side-effects continue to fire after the HTTP response below.
      dispatchNotifications({
        tenantId: resolvedTenantId,
        tenantSlug: slug,
        bookingId,
        created,
        joined,
        authEmail: req.auth?.email,
        reqTenantId: req.tenantId,
      });

      return res.status(created ? 201 : 200).json({
        booking: joined,
        replay: !created,
        tax: {
          subtotal_amount:       taxData.subtotal_amount,
          vat_amount:            taxData.vat_amount,
          service_charge_amount: taxData.service_charge_amount,
          total_amount:          taxData.total_amount,
        },
        debug: {
          service: process.env.RENDER_SERVICE_NAME || process.env.SERVICE_NAME || null,
          dbName: (() => {
            try {
              const u = new URL(String(process.env.DATABASE_URL || ""));
              return u.pathname ? u.pathname.replace(/^\//, "") : null;
            } catch {
              return null;
            }
          })(),
        },
      });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error creating booking:", err);
    return res
      .status(500)
      .json({ error: "Failed to create booking.", details: String(err) });
  }
});
};
