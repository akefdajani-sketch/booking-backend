// routes/bookings/create.js
// POST / (booking creation engine)
// Mounted by routes/bookings.js

const db = require("../../db");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { ensureBookingMoneyColumns } = require("../../utils/ensureBookingMoneyColumns");
const { loadJoinedBookingById } = require("../../utils/bookings");
const { getIdempotencyKey, bumpTenantBookingChange } = require("../../utils/bookingRouteHelpers");
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
    // No-op if already applied — ensures revenue/price columns on older DBs.
    await ensureBookingMoneyColumns();

    // ─── Phase 1: input parsing + customer resolution ────────────────────────
    // PR 2: parseInputs runs first so a missing-startTime request never
    // creates a customer row.
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

    // Policy load runs before resolveCustomer; enforcement below uses the
    // stored finalCustomerPhone.
    const requirePhone = await validate.loadRequirePhonePolicy(resolvedTenantId);

    // Public booking: identity from Google. Admin proxy: from request payload.
    // We NEVER trust customerId from the client for authenticated flows.
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

    // PR 2: nightly-mode startTime derivation + invalid-date + past-check.
    const startResult = validate.deriveStartTime({
      startTime,
      checkin_date,
      incomingBookingMode,
    });
    if (!startResult.ok) return res.status(startResult.status).json(startResult.body);
    const { resolvedStartTime, start, isNightlyBooking } = startResult;

    // ─── Phase 2: service load + staff/resource + availability ───────────────
    // PR 3: service load + column probes.
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

    // PR 2: staff/resource parse + per-tenant existence checks.
    const staffResult = await validate.validateStaffAndResource({
      staffId,
      resourceId,
      tenantId: resolvedTenantId,
    });
    if (!staffResult.ok) return res.status(staffResult.status).json(staffResult.body);
    const { staff_id, resource_id } = staffResult;

    // PR 3: blackout + conflict + Gate A working-hours. Runs after
    // validateStaffAndResource so staff_id / resource_id are available.
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

    // ─── Phase 3: BEGIN transaction ───────────────────────────────────────────
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Trimmed customer aliases for downstream INSERT.
      const cleanName = String(finalCustomerName || "Customer").trim();
      const cleanPhone = finalCustomerPhone ? String(finalCustomerPhone).trim() : null;
      const cleanEmail = finalCustomerEmail ? String(finalCustomerEmail).trim() : null;

      // ─── Phase 4: membership + prepaid resolution ───────────────────────────
      // PR 5: each module owns its own ROLLBACK on entitlement failure.
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

      const initialStatus = requiresConfirmation ? "pending" : "confirmed";

      // ─── Phase 5: pricing ─────────────────────────────────────────────────────
      // PR 4: pool-only pricing pipeline. Orchestrator owns the ROLLBACK on
      // Gate B failure (matches the post-BEGIN failure convention).
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

      // ─── Phase 6: persist + entitlement writes ───────────────────────────────
      // PR 6: persist.js (booking row + booking_code + sessions) and
      // applyEntitlementWrites.js (ledger + prepaid). Each owns its own
      // ROLLBACK. The 4 PR-5 back-edges are pass-through into entitlement ctx.
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
      // applyEntitlementWrites mutates prepaidApplied in place (redemptionId +
      // remainingQuantity from RETURNING); returned for boundary visibility.

      // ─── Phase 7: COMMIT + post-commit side effects ──────────────────────────
      await client.query("COMMIT");

      // 🔥 Heartbeat + UI refresh bump.
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

      // PR 1: post-COMMIT WA/SMS/email dispatch + AI cache bust. Fire-and-
      // forget — side effects continue after the HTTP response below.
      dispatchNotifications({
        tenantId: resolvedTenantId,
        tenantSlug: slug,
        bookingId,
        created,
        joined,
        authEmail: req.auth?.email,
        reqTenantId: req.tenantId,
      });

      // ─── Phase 8: response ────────────────────────────────────────────────────
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
