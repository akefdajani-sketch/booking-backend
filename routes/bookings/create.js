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
const { findOrCreateSession, incrementSessionCount, decrementSessionCount, loadJoinedBookingById } = require("../../utils/bookings");
const { ensureBookingRateColumns } = require("../../utils/ensureBookingRateColumns");
const { ensurePaymentMethodColumn } = require("../../utils/ensurePaymentMethodColumn");
const {
  shouldUseCustomerHistory, servicesHasColumn, getServiceAllowMembership,
  getIdempotencyKey, mustHaveTenantSlug, canTransitionStatus, bumpTenantBookingChange,
  prepaidTablesExist, resolvePrepaidSelection, computePrepaidRedemptionSelection,
  loadMembershipCheckoutPolicy, roundUpMinutes, buildMembershipResolution,
  buildMembershipInsufficientPayload,
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


      // Optional: apply customer membership (atomic debit in the same transaction)
      let finalCustomerMembershipId = null;
      let debitMinutes = 0;
      let debitUses = 0;
      let prepaidApplied = null;

      // Snapshot of selected membership balance BEFORE debit (for resolution UI)
      let membershipBefore = null;

      // Tenant membership checkout policy (defaults safe)
      const membershipPolicy = await loadMembershipCheckoutPolicy(client, resolvedTenantId);

      // Optional: auto-consume an eligible membership entitlement (platform-safe, no schema change)
      // If requireMembership=true, we will HARD FAIL when no eligible entitlement exists.
      let wantAutoMembership =
        (autoConsumeMembership === true || String(autoConsumeMembership).toLowerCase() === "true");
      let wantRequireMembership =
        (requireMembership === true || String(requireMembership).toLowerCase() === "true");

      // Service-level eligibility guard:
      // We only allow membership debits for services explicitly marked allow_membership=true.
      // This prevents accidental credit use for non-membership products (e.g., lessons, karaoke).
      const membershipRequested =
        wantAutoMembership || wantRequireMembership || (customerMembershipId != null && String(customerMembershipId).trim() !== "");

      if (membershipRequested) {
        if (!serviceId) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Membership credits require a service selection." });
        }

        const svcRule = await getServiceAllowMembership(client, resolvedTenantId, serviceId);
        if (!svcRule.allowed) {
          // Hard-fail when the caller explicitly requested membership use.
          if (wantRequireMembership || (customerMembershipId != null && String(customerMembershipId).trim() !== "")) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              error: "This service is not eligible for membership credits. Ask the business to enable membership for this service in Setup → Memberships.",
            });
          }

          // Soft mode: ignore auto consumption for non-eligible services.
          wantAutoMembership = false;
          wantRequireMembership = false;
        }
      }

      if (!finalCustomerMembershipId && (wantAutoMembership || wantRequireMembership) && !customerMembershipId) {
        if (!finalCustomerId) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Membership consumption requires a signed-in customer." });
        }

        // Pick ONE eligible active membership deterministically.
        // Eligibility: active + not expired + (has any remaining balance: minutes_remaining > 0 OR uses_remaining > 0)
        // NOTE: We intentionally allow selecting an insufficient membership so the UX can offer Smart Top-Up.
        // Ordering: soonest expiry first (NULLS LAST), then highest remaining balance, then id.
        const eligible = await client.query(
          `
          SELECT id, customer_id, minutes_remaining, uses_remaining
          FROM customer_memberships
          WHERE tenant_id = $1
            AND customer_id = $2
            AND COALESCE(status, 'active') = 'active'
            AND (end_at IS NULL OR end_at > NOW())
            AND (COALESCE(minutes_remaining,0) > 0 OR COALESCE(uses_remaining,0) > 0)
          ORDER BY
            end_at NULLS LAST,
            end_at ASC,
            COALESCE(minutes_remaining,0) DESC,
            COALESCE(uses_remaining,0) DESC,
            id ASC
          LIMIT 1
          FOR UPDATE
          `,
          [resolvedTenantId, finalCustomerId]
        );

        if (!eligible.rows.length) {
          if (wantRequireMembership) {
            await client.query("ROLLBACK");
            const payload = buildMembershipInsufficientPayload({ policy: membershipPolicy, durationMinutes: Number(duration), membershipBefore: null, membershipId: null });
            payload.message = "No eligible membership entitlement found.";
            return res.status(409).json(payload);
          }
          // soft mode: proceed without membership
        } else {
          const cm = eligible.rows[0];
          const minsRemaining = Number(cm.minutes_remaining || 0);
          const usesRemaining = Number(cm.uses_remaining || 0);

          // Debit policy mirrors the explicit membership path:
          // capture balances for resolution
          membershipBefore = { minutes_remaining: minsRemaining, uses_remaining: usesRemaining, id: cm.id };

          if (minsRemaining >= Number(duration)) {
            debitMinutes = -Number(duration);
            debitUses = 0;
          } else if (usesRemaining >= 1) {
            debitMinutes = 0;
            debitUses = -1;
          } else if (wantRequireMembership) {
            await client.query("ROLLBACK");
            return res.status(409).json(buildMembershipInsufficientPayload({ policy: membershipPolicy, durationMinutes: Number(duration), membershipBefore, membershipId: cm.id }));
          }

          finalCustomerMembershipId = cm.id;
        }
      }



      if (customerMembershipId != null && String(customerMembershipId).trim() !== "") {
        const cmid = Number(customerMembershipId);
        if (!Number.isFinite(cmid) || cmid <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Invalid customerMembershipId." });
        }

        // Lock the membership row to prevent concurrent double-spend.
        const cmRes = await client.query(
          `
          SELECT id, customer_id, status, end_at, minutes_remaining, uses_remaining
          FROM customer_memberships
          WHERE id=$1 AND tenant_id=$2
          FOR UPDATE
          `,
          [cmid, resolvedTenantId]
        );

        if (!cmRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Unknown customerMembershipId for tenant." });
        }

        const cm = cmRes.rows[0];

        // If booking is linked to a customer, enforce membership belongs to same customer.
        if (finalCustomerId && Number(cm.customer_id) !== Number(finalCustomerId)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Membership does not belong to this customer." });
        }

        if (String(cm.status) !== "active" || (cm.end_at && new Date(cm.end_at).getTime() <= Date.now())) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Membership is not active or is expired." });
        }

        const minsRemaining = Number(cm.minutes_remaining || 0);
        const usesRemaining = Number(cm.uses_remaining || 0);

        membershipBefore = { minutes_remaining: minsRemaining, uses_remaining: usesRemaining, id: cm.id };

        // Default debit policy:
        // - If membership has enough minutes, debit booking duration minutes.
        // - Otherwise, if it has uses, debit 1 use.
        // (You can make this service-specific later.)
        if (minsRemaining >= Number(duration)) {
          debitMinutes = -Number(duration);
          debitUses = 0;
        } else if (usesRemaining >= 1) {
          debitMinutes = 0;
          debitUses = -1;
        } else {
          await client.query("ROLLBACK");
          return res.status(409).json(buildMembershipInsufficientPayload({ policy: membershipPolicy, durationMinutes: Number(duration), membershipBefore, membershipId: cm.id }));
        }

        finalCustomerMembershipId = cm.id;
      }

      const prepaidRequested =
        autoConsumePrepaid === true || String(autoConsumePrepaid).toLowerCase() === "true" ||
        requirePrepaid === true || String(requirePrepaid).toLowerCase() === "true" ||
        (prepaidEntitlementId != null && String(prepaidEntitlementId).trim() !== "");

      if (prepaidRequested) {
        if (!finalCustomerId) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Prepaid redemption requires a signed-in customer." });
        }
        const prepaidReady = await prepaidTablesExist(client);
        if (!prepaidReady) {
          await client.query("ROLLBACK");
          return res.status(503).json({ error: "Prepaid accounting schema is not installed." });
        }

        const selectedEntitlement = await resolvePrepaidSelection(client, {
          tenantId: resolvedTenantId,
          customerId: finalCustomerId,
          entitlementId: prepaidEntitlementId ? Number(prepaidEntitlementId) : null,
          serviceId: resolvedServiceId,
        });

        if (!selectedEntitlement) {
          if (requirePrepaid === true || String(requirePrepaid).toLowerCase() === "true") {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "No eligible prepaid balance found for this booking." });
          }
        } else {
          const prepaidSelection = computePrepaidRedemptionSelection(selectedEntitlement, Number(duration), Number(serviceDurationMinutes || duration || 0));
          const remaining = Number(selectedEntitlement.remaining_quantity || 0);
          if (remaining < prepaidSelection.redeemedQuantity) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "Insufficient prepaid balance for this booking." });
          }
          prepaidApplied = {
            entitlementId: Number(selectedEntitlement.id),
            prepaidProductId: Number(selectedEntitlement.prepaid_product_id),
            prepaidProductName: selectedEntitlement.prepaid_product_name || null,
            redeemedQuantity: prepaidSelection.redeemedQuantity,
            redemptionMode: prepaidSelection.redemptionMode,
            notes: `Applied to booking`,
          };
        }
      }

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

      // Derive payment_method for this booking
      // Membership/package/free are always derived server-side.
      // Cash/CliQ/Card record customer INTENT — payment success/failure is a
      // separate concern tracked by network_payments.status (for card) or
      // operator confirmation (for CliQ bank transfers and cash).
      //
      // PAY-INTENT-1 (May 4, 2026): Removed the `&& networkPaymentOrderId`
      // guard for card/cliq. The old guard required an MPGS order ID before
      // recording the method, which:
      //   - permanently dropped CliQ on the floor (CliQ never has an order ID
      //     because it's a manual bank transfer, not a gateway transaction)
      //   - left card bookings NULL whenever the post-payment result page
      //     didn't reach the success endpoint (mobile abandons, network drops)
      // Both produced the 412/657 (63%) NULL rate found in the May audit.
      //
      // The networkPayments.js webhook still updates payment_method = 'card'
      // on verified gateway success; that update is now a no-op when the
      // create-booking call already wrote 'card' — idempotent.
      const payment_method = finalCustomerMembershipId
        ? 'membership'
        : prepaidApplied
          ? 'package'
          : (price_amount == null || price_amount === 0)
            ? 'free'
            : requestedPaymentMethod === 'cash'
              ? 'cash'
              : (requestedPaymentMethod === 'card' || requestedPaymentMethod === 'cliq')
                ? requestedPaymentMethod  // PAY-INTENT-1: trust client-declared method
                : null;

      // CLIQ-CONFIRM-1 (May 4, 2026): Derive payment_status alongside the
      // method. payment_method is INTENT, payment_status is the actual money
      // state. Backend rules:
      //   membership/package/free/cash  → 'completed' (auto-settled)
      //   card with networkPaymentOrderId → 'completed' (gateway already verified)
      //   card without orderId          → 'pending'   (waiting for webhook)
      //   cliq                          → 'pending'   (waiting for operator)
      //   null payment_method           → null status (historical/unknown)
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

      let bookingId;
      let created = true;
      try {
        // ── Session handling for parallel services ──────────────────────────────
        // If the service has max_parallel_bookings > 1, find or create a session
        // and check capacity. This happens inside the transaction so the
        // confirmed_count increment and booking INSERT are atomic.
        let resolvedSessionId = null;
        if (serviceMaxParallel > 1 && resolvedServiceId) {
          const sessionResult = await findOrCreateSession({
            client,
            tenantId: resolvedTenantId,
            serviceId: resolvedServiceId,
            resourceId: resource_id,
            staffId: staff_id,
            startTimeIso: start.toISOString(),
            durationMinutes: duration,
            maxCapacity: serviceMaxParallel,
          });
          if (sessionResult.full) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              error: "This session is full. No spots remaining.",
              spotsRemaining: 0,
            });
          }
          resolvedSessionId = sessionResult.sessionId;
        }

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

        let baseVals = [resolvedTenantId, resolvedServiceId, staff_id, resource_id,
             start.toISOString(), duration,
             finalCustomerId, cleanName, cleanPhone, cleanEmail,
             initialStatus, idemKey, finalCustomerMembershipId, resolvedSessionId];
        if (hasPaymentMethodCol) baseVals.push(payment_method);
        if (hasPaymentStatusCol) baseVals.push(payment_status);  // CLIQ-CONFIRM-1
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

        // Build INSERT dynamically so parameter indices are always correct.
        function makePlaceholders(params) {
          return params.map((_, i) => `$${i + 1}`).join(', ');
        }

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

        const insert = await client.query(insertSql, insertParams);
        bookingId = insert.rows[0].id;

        // PAY-FIX: link this booking back to the MPGS payment record.
        // When the result page creates the booking after gateway confirmation,
        // it passes networkPaymentOrderId so we can close the loop:
        //   network_payments.booking_id → this booking
        //   bookings.payment_method    → already set to 'card' above
        if (networkPaymentOrderId && bookingId) {
          try {
            await client.query(
              `UPDATE network_payments
               SET booking_id  = $1,
                   updated_at  = NOW()
               WHERE order_id  = $2
                 AND tenant_id = $3`,
              [bookingId, String(networkPaymentOrderId).trim(), resolvedTenantId]
            );
          } catch (linkErr) {
            // Non-fatal — booking is created; just the payment linkage failed.
            // The payment record and booking both exist and can be reconciled manually.
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
          // Idempotency replay: same key used before – return the existing booking.
          const existing = await client.query(
            `SELECT id FROM bookings WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1`,
            [resolvedTenantId, idemKey]
          );
          if (existing.rows.length) {
            bookingId = existing.rows[0].id;
            created = false;
          } else {
            throw err;
          }
        } else if (err && err.code === "23P01") {
          // ── Exclusion constraint violation ────────────────────────────────────
          // The production DB has an EXCLUDE USING GIST constraint on
          // (tenant_id, resource_id, booking_range) that prevents overlapping
          // bookings on the same resource.  For parallel/group services this
          // constraint fires on the 2nd+ participant even though the session has
          // capacity – a false conflict.
          //
          // FIX: run migration 012_drop_booking_range_exclude.sql to remove the
          // constraint permanently. Until then, surface this as a clean 409
          // instead of a 500 so the UI can show a helpful message.
          //
          // For single-capacity services a 23P01 here is a genuine double-book
          // that slipped past checkConflicts (race condition); 409 is still correct.
          await client.query("ROLLBACK");
          if (serviceMaxParallel > 1) {
            return res.status(409).json({
              error:
                "A database constraint is blocking this parallel booking. " +
                "Please ask your administrator to run migration " +
                "012_drop_booking_range_exclude.sql on the production database.",
              code: "PARALLEL_BOOKING_CONSTRAINT",
            });
          }
          return res.status(409).json({
            error: "Booking conflicts with an existing booking (resource overlap).",
            code: "RESOURCE_CONFLICT",
          });
        } else {
          throw err;
        }
      }

      // ── Booking code generation ──────────────────────────────────────────────
      // New format:  {PREFIX}-{TYPE}-{YYMMDD}-{SEQ4}
      //
      //   PREFIX  = tenants.booking_code_prefix (e.g. BRD, AQB)
      //             fallback: first 3 chars of slug, uppercased
      //   TYPE    = TS (time_slots) | NT (nightly) | LS (lease)
      //   YYMMDD  = service start date for timeslot; check-in date for nightly
      //   SEQ4    = per-tenant ever-incrementing counter, zero-padded to 4 digits
      //
      // Examples:
      //   Birdie golf:    BRD-TS-260226-0079
      //   Aqaba nightly:  AQB-NT-260415-0001
      //
      // The seq increment runs inside the same DB transaction so it is atomic.
      // ────────────────────────────────────────────────────────────────────────
      let bookingCode;
      try {
        const seqResult = await client.query(
          `UPDATE tenants
             SET booking_seq = booking_seq + 1
           WHERE id = $1
           RETURNING booking_seq, booking_code_prefix, slug`,
          [resolvedTenantId]
        );
        const seqRow = seqResult.rows[0];
        const seq    = seqRow?.booking_seq ?? 1;

        // Prefix: owner-set value, else first 3 chars of slug
        const rawPrefix  = (seqRow?.booking_code_prefix || "").trim().toUpperCase();
        const slugPrefix = (seqRow?.slug || "BKG").replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase();
        const prefix     = rawPrefix || slugPrefix;

        // Type code
        const bookingType = isNightlyBooking ? "NT" : "TS";

        // Date — start date for timeslot, check-in date for nightly (YYMMDD)
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
        bookingCode = `${firstLetter}-${resolvedTenantId}-${resolvedServiceId || 0}-${ymd}-${bookingId}`;
      }

      await client.query(
        `UPDATE bookings
           SET booking_code = COALESCE(booking_code, $1)
         WHERE id = $2 AND tenant_id = $3`,
        [bookingCode, bookingId, resolvedTenantId]
      );


      // If a membership was provided, debit it once per booking (idempotent by unique constraint).
      if (finalCustomerMembershipId) {
        const minutesDelta = Number(debitMinutes || 0);
        const usesDelta = Number(debitUses || 0);

        // Guard: never write a no-op ledger line.
        // This can happen if durationMinutes is accidentally 0, or if the debit policy fails to set deltas.
        if (minutesDelta === 0 && usesDelta === 0) {
          await client.query("ROLLBACK");
          return res.status(500).json({
            error: "Membership debit failed: computed a zero delta. Please contact support.",
          });
        }

        let ledgerInserted = false;
        try {
          await client.query(
            `
            INSERT INTO membership_ledger
              (tenant_id, customer_membership_id, booking_id, type, minutes_delta, uses_delta, note)
            VALUES
              ($1, $2, $3, 'debit', $4, $5, $6)
            `,
            [
              resolvedTenantId,
              finalCustomerMembershipId,
              bookingId,
              minutesDelta || null,
              usesDelta || null,
              `Debit for booking ${bookingId}`,
            ]
          );
          ledgerInserted = true;
        } catch (e) {
          // If this is a replay, the ledger row may already exist. Ignore unique-violation.
          if (!(e && e.code === "23505")) throw e;
        }

        // Apply balance changes in the SAME transaction.
        // We intentionally do this in application code (not only triggers) so the system remains correct
        // even if the DB trigger set is incomplete in a given environment.
        //
        // IMPORTANT: Only apply the balance update if we actually inserted the ledger line.
        // If a unique-violation happened (replay), we must NOT double-debit.
        if (ledgerInserted) {
	          // Guard against going negative. This prevents a hard 500 (constraint violation)
	          // and turns it into a clean "insufficient balance" response.
	          const balRes = await client.query(
              `
              UPDATE customer_memberships cm
              SET
                minutes_remaining = GREATEST(
                  0,
                  COALESCE(
                    (
                      SELECT SUM(ml.minutes_delta)
                      FROM membership_ledger ml
                      WHERE ml.customer_membership_id = cm.id
                    ),
                    0
                  )
                ),
                uses_remaining = GREATEST(
                  0,
                  COALESCE(
                    (
                      SELECT SUM(ml.uses_delta)
                      FROM membership_ledger ml
                      WHERE ml.customer_membership_id = cm.id
                    ),
                    0
                  )
                )
              WHERE cm.id = $1 AND cm.tenant_id = $2
              RETURNING id, minutes_remaining, uses_remaining
              `,
              [finalCustomerMembershipId, resolvedTenantId]
            );

	          if (balRes.rowCount === 0) {
	            await client.query('ROLLBACK');
	            return res.status(409).json({
              error: 'membership_insufficient_balance',
              message:
                'Membership does not have enough remaining balance for this booking. Please choose a shorter duration or a different payment option.',
              resolution: (() => {
                try {
                  const before = membershipBefore || {};
                  const beforeMins = Number(before.minutes_remaining ?? 0);
                  const beforeUses = Number(before.uses_remaining ?? 0);

                  // When we attempted a debit that would go negative, compute the shortage.
                  const minutesShort =
                    minutesDelta < 0 ? Math.max(0, -(beforeMins + minutesDelta)) : 0;
                  const usesShort =
                    usesDelta < 0 ? Math.max(0, -(beforeUses + usesDelta)) : 0;

                  const r = buildMembershipResolution({
                    policy: membershipPolicy,
                    minutesShort,
                    usesShort,
                  });
                  r.membershipId = before.id || null;
                  return r;
                } catch {
                  return buildMembershipResolution({ policy: membershipPolicy, minutesShort: 0, usesShort: 0 });
                }
              })()
            });
	          }

	          // If balance is now depleted, expire the membership so the customer can renew.
	          // Works for minutes-only, uses-only, or hybrid (Birdie) memberships.
	          try {
	            const newBal = balRes.rows[0] || {};
	            const mins = Number(newBal.minutes_remaining ?? 0);
	            const uses = Number(newBal.uses_remaining ?? 0);

	            if (mins <= 0 && uses <= 0) {
	              await client.query(
	                `
	                UPDATE customer_memberships
	                SET status = 'expired'
	                WHERE id = $1 AND tenant_id = $2 AND status = 'active'
	                `,
	                [finalCustomerMembershipId, resolvedTenantId]
	              );
	            } else {
	              // Time-based expiry guard (in case end_at has passed)
	              await client.query(
	                `
	                UPDATE customer_memberships
	                SET status = 'expired'
	                WHERE id = $1 AND tenant_id = $2 AND status = 'active'
	                  AND end_at IS NOT NULL AND end_at <= NOW()
	                `,
	                [finalCustomerMembershipId, resolvedTenantId]
	              );
	            }
	          } catch (eExpire) {
	            // Don't fail booking if the expiry update fails; balances + ledger are already correct.
	            console.warn("Membership expiry update failed (non-fatal):", eExpire?.message || eExpire);
	          }
        }
      }

      if (prepaidApplied) {
        const redemptionRes = await client.query(
          `
          INSERT INTO prepaid_redemptions (
            tenant_id,
            booking_id,
            customer_id,
            entitlement_id,
            prepaid_product_id,
            redeemed_quantity,
            redemption_mode,
            notes,
            metadata
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
          RETURNING *
          `,
          [
            resolvedTenantId,
            bookingId,
            finalCustomerId,
            prepaidApplied.entitlementId,
            prepaidApplied.prepaidProductId,
            prepaidApplied.redeemedQuantity,
            prepaidApplied.redemptionMode,
            prepaidApplied.notes,
            JSON.stringify({ source: 'booking_create' }),
          ]
        );
        prepaidApplied.redemptionId = redemptionRes.rows?.[0]?.id || null;

        const entUpdate = await client.query(
          `
          UPDATE customer_prepaid_entitlements
          SET
            remaining_quantity = GREATEST(0, COALESCE(remaining_quantity,0) - $3),
            status = CASE WHEN GREATEST(0, COALESCE(remaining_quantity,0) - $3) = 0 THEN 'consumed' ELSE status END,
            updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2
          RETURNING remaining_quantity
          `,
          [resolvedTenantId, prepaidApplied.entitlementId, prepaidApplied.redeemedQuantity]
        );
        prepaidApplied.remainingQuantity = entUpdate.rows?.[0]?.remaining_quantity ?? null;

        await client.query(
          `
          INSERT INTO prepaid_transactions (
            tenant_id,
            customer_id,
            entitlement_id,
            prepaid_product_id,
            transaction_type,
            quantity_delta,
            money_amount,
            currency,
            notes,
            metadata,
            actor_user_id
          )
          VALUES ($1,$2,$3,$4,'redemption',$5,NULL,NULL,$6,$7::jsonb,NULL)
          `,
          [
            resolvedTenantId,
            finalCustomerId,
            prepaidApplied.entitlementId,
            prepaidApplied.prepaidProductId,
            -prepaidApplied.redeemedQuantity,
            `Applied to booking ${bookingId}`,
            JSON.stringify({ bookingId }),
          ]
        );
      }

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
