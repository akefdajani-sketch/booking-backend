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
const { findOrCreateSession, incrementSessionCount, decrementSessionCount, loadJoinedBookingById, checkConflicts } = require("../../utils/bookings");
const { computeRateForBookingLike } = require("../../utils/ratesEngine");
const { computeTaxForBooking } = require("../../utils/taxEngine");
// PR 149: server-side booking policy gates (working hours + require-charge)
const { getBookingPolicy, validateWithinWorkingHours, validateRequireCharge } = require("../../utils/bookingPolicy");
const { ensureBookingRateColumns } = require("../../utils/ensureBookingRateColumns");
const { ensurePaymentMethodColumn } = require("../../utils/ensurePaymentMethodColumn");
const {
  shouldUseCustomerHistory, checkBlackoutOverlap, servicesHasColumn, getServiceAllowMembership,
  getIdempotencyKey, mustHaveTenantSlug, canTransitionStatus, bumpTenantBookingChange,
  prepaidTablesExist, resolvePrepaidSelection, computePrepaidRedemptionSelection,
  loadMembershipCheckoutPolicy, roundUpMinutes, buildMembershipResolution,
  buildMembershipInsufficientPayload,
} = require("../../utils/bookingRouteHelpers");


module.exports = function mount(router) {
router.post("/", requireAppAuth, requireTenant, async (req, res) => {
  try {
    // Ensure revenue/price columns exist in older DBs.
    // (No-op if already applied.)
    await ensureBookingMoneyColumns();

    const {
      tenantSlug,
      serviceId,
      startTime,
      durationMinutes,
      // customerName/phone/email may be sent by older UIs, but the platform now
      // trusts Google auth + customer profile as the source of truth.
      customerName,
      customerPhone,
      customerEmail,
      staffId,
      resourceId,
      customerId,
      customerMembershipId,
      autoConsumeMembership,
      requireMembership,
      prepaidEntitlementId,
      autoConsumePrepaid,
      requirePrepaid,
      paymentMethod: requestedPaymentMethod, // PAY-2: cash | card | cliq from client
      networkPaymentOrderId, // PAY-1: MPGS order ID when booking follows card payment
      // RENTAL-1: nightly booking fields
      booking_mode: incomingBookingMode,
      checkin_date,
      checkout_date,
      nights_count,
      // NIGHTLY SUITE: add-ons and guests
      addons_json: incomingAddonsJson,
      guests_count: incomingGuestsCount,
    } = req.body || {};

    const slug = (req.tenantSlug || tenantSlug || "").toString().trim();
    const resolvedTenantId = Number(req.tenantId || 0);
    if (!slug) return res.status(400).json({ error: "Missing tenantSlug." });
    if (!Number.isFinite(resolvedTenantId) || resolvedTenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenant." });
    }

    const idemKey = getIdempotencyKey(req);

    const isAdminBypass = !!req.adminBypass;

    const googleEmail = (req.auth?.email || req.googleUser?.email || "").toString().trim().toLowerCase();
    const googleName = (req.auth?.name || req.googleUser?.name || req.googleUser?.given_name || "").toString().trim();

    // Public booking requires the *customer* Google identity.
    // Owner/tenant dashboards may create bookings on behalf of customers via ADMIN_API_KEY proxy.
    if (!isAdminBypass && !googleEmail) return res.status(401).json({ error: "Unauthorized" });

    const requestedCustomerEmail = (isAdminBypass ? String(customerEmail || "") : String(googleEmail || ""))
      .trim()
      .toLowerCase();

    if (isAdminBypass && !requestedCustomerEmail) {
      return res.status(400).json({ error: "customerEmail is required for staff/admin bookings." });
    }

    if (!startTime) {
      return res.status(400).json({ error: "Missing required fields (startTime)." });
    }

    // Tenant policy: require customer phone unless explicitly disabled.
    // (Schema-free Phase C: read from tenants.branding JSONB when available.)
    let requirePhone = true;
    try {
      const tpol = await db.query(`SELECT branding FROM tenants WHERE id=$1 LIMIT 1`, [resolvedTenantId]);
      const branding = tpol.rows?.[0]?.branding || {};
      const v = branding?.require_phone ?? branding?.requirePhone ?? branding?.phone_required ?? branding?.phoneRequired;
      if (typeof v === "boolean") requirePhone = v;
      if (typeof v === "string" && v.trim() !== "") {
        requirePhone = ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());
      }
    } catch (_) {
      // keep default
    }

    // Resolve or create customer for this tenant.
    // - Public booking: customer identity comes from Google.
    // - Staff/admin booking (owner proxy): customer identity comes from request payload.
    // IMPORTANT: we NEVER trust customerId from the client for authenticated flows.
    let finalCustomerId = null;

    let finalCustomerName = (
      isAdminBypass
        ? String(customerName || "").trim()
        : (googleName || "").trim()
    ) || "Customer";

    let finalCustomerPhone = String(customerPhone || "").trim() || null;
    let finalCustomerEmail = requestedCustomerEmail;

    const existingCust = await db.query(
      `SELECT id, name, phone, email
       FROM customers
       WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)
       LIMIT 1`,
      [resolvedTenantId, finalCustomerEmail]
    );

    if (existingCust.rows.length) {
      const row = existingCust.rows[0];
      finalCustomerId = row.id;
      finalCustomerName = String(row.name || finalCustomerName).trim() || finalCustomerName;
      // Prefer stored phone; only update if client supplied a phone.
      finalCustomerPhone = String(row.phone || "").trim() || finalCustomerPhone;
    } else {
      // Create a minimal customer record.
      const ins = await db.query(
        `INSERT INTO customers (tenant_id, name, phone, email, created_at)
         VALUES ($1,$2,$3,$4,NOW())
         RETURNING id`,
        [resolvedTenantId, finalCustomerName, finalCustomerPhone, finalCustomerEmail]
      );
      finalCustomerId = ins.rows?.[0]?.id || null;
    }

    if (!finalCustomerId) {
      return res.status(500).json({ error: "Failed to resolve customer." });
    }

    if (requirePhone && !String(finalCustomerPhone || "").trim()) {
      return res.status(409).json({
        error: "Phone number required before booking.",
        code: "PROFILE_INCOMPLETE",
        fields: ["phone"],
      });
    }

    // RENTAL-1: For nightly bookings, derive startTime from checkin_date if not provided
    const isNightlyBooking = incomingBookingMode === 'nightly';
    let resolvedStartTime = startTime;
    if (isNightlyBooking && !startTime && checkin_date) {
      resolvedStartTime = new Date(`${checkin_date}T00:00:00Z`).toISOString();
    }
    if (!resolvedStartTime) {
      return res.status(400).json({ error: "Missing required fields (startTime)." });
    }

    const start = new Date(resolvedStartTime);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime." });
    }

    const now = new Date();
    // Nightly: allow same-day check-in (compare against today midnight)
    const pastThreshold = isNightlyBooking
      ? (() => { const d = new Date(now); d.setHours(0,0,0,0); return d.getTime(); })()
      : now.getTime() - 60 * 1000;
    if (start.getTime() < pastThreshold) {
      return res.status(400).json({ error: "Cannot create a booking in the past." });
    }

    let resolvedServiceId = serviceId ? Number(serviceId) : null;
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
        const tc = await db.query(`SELECT currency_code FROM tenants WHERE id=$1 LIMIT 1`, [resolvedTenantId]);
        tenantCurrencyCode = tc.rows?.[0]?.currency_code || null;
      }

      const sRes = await db.query(
        `SELECT id, tenant_id, duration_minutes, max_parallel_bookings, ${priceExpr}${hasPricePerNight ? ", price_per_night" : ""}${hasReqConf ? ", COALESCE(requires_confirmation,false) AS requires_confirmation" : ""}
         FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [resolvedServiceId, resolvedTenantId]
      );
      if (!sRes.rows.length)
        return res.status(400).json({ error: "Unknown serviceId for tenant." });

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

    const bookingStatus = requiresConfirmation ? "pending" : "confirmed";

    const staff_id = staffId ? Number(staffId) : null;
    const resource_id = resourceId ? Number(resourceId) : null;

    if (staff_id) {
      const st = await db.query(
        `SELECT id FROM staff WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [staff_id, resolvedTenantId]
      );
      if (!st.rows.length)
        return res.status(400).json({ error: "staffId not valid for tenant." });
    }
    if (resource_id) {
      const rr = await db.query(
        `SELECT id FROM resources WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [resource_id, resolvedTenantId]
      );
      if (!rr.rows.length)
        return res
          .status(400)
          .json({ error: "resourceId not valid for tenant." });
    }

    // ✅ Enforce blackout windows (closures) before running conflict checks.
    // This ensures that even if no bookings exist, closed windows remain unbookable.
    const end = new Date(start.getTime() + Number(duration) * 60 * 1000);
    const blackout = await checkBlackoutOverlap({
      tenantId: resolvedTenantId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      resourceId: resource_id,
      staffId: staff_id,
      serviceId: resolvedServiceId,
    });
    if (blackout) {
      return res.status(409).json({
        error: "This time window is blocked.",
        blackout,
      });
    }

    const conflicts = await checkConflicts({
      tenantId: resolvedTenantId,
      staffId: staff_id,
      resourceId: resource_id,
      startTime: start.toISOString(),
      durationMinutes: duration,
      serviceId: resolvedServiceId,
      maxParallel: serviceMaxParallel,
    });

    if (conflicts.conflict) {
      return res.status(409).json({
        error: "Booking conflicts with an existing booking.",
        conflicts,
      });
    }

    // ─── PR 149: Gate A — working-hours validation ─────────────────────────
    // Resolve tenant timezone + policy, then re-check startTime against
    // tenant_hours for the LOCAL day-of-week in the tenant's zone. The
    // availability endpoint enforces this at slot-generation time, but
    // nothing was re-validating it on create — so a client could POST any
    // startTime and the server happily accepted it (see bug with BRD-TS-
    // 260420-0069, booked from Malaysia for 06:00 Asia/Amman while Birdie
    // opens at 10:00). Admin/owner bypass is exempt.
    const bookingPolicy = await getBookingPolicy(resolvedTenantId);

    if (!isAdminBypass && bookingPolicy.enforceWorkingHours) {
      let tenantTzForPolicy = 'UTC';
      try {
        const tzRow = await db.query(
          `SELECT timezone FROM tenants WHERE id = $1 LIMIT 1`,
          [resolvedTenantId]
        );
        tenantTzForPolicy = tzRow.rows?.[0]?.timezone || 'UTC';
      } catch { /* fall through with UTC */ }

      const hoursCheck = await validateWithinWorkingHours({
        tenantId:        resolvedTenantId,
        tenantTz:        tenantTzForPolicy,
        startTime:       start.toISOString(),
        durationMinutes: duration,
      });

      if (!hoursCheck.ok) {
        return res.status(422).json({
          error:   hoursCheck.message,
          code:    hoursCheck.code,
          details: hoursCheck.details,
        });
      }
    }
    // ─── End Gate A ────────────────────────────────────────────────────────

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

      // Compute price + charge amounts.
      // - price_amount represents the booking's list price/value.
      // - charge_amount is what we actually charge (0 if covered by membership).
      // Compute price amount.
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
        if (resolvedServiceId) {
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
            tenantId: resolvedTenantId,
            serviceId: resolvedServiceId,
            staffId: staff_id,
            resourceId: resource_id,
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
      if (!isAdminBypass && bookingPolicy.requireCharge) {
        const chargeCheck = validateRequireCharge({
          priceAmount:               price_amount,
          finalCustomerMembershipId,
          prepaidApplied,
          serviceId:                 resolvedServiceId,
        });
        if (!chargeCheck.ok) {
          await client.query("ROLLBACK");
          return res.status(422).json({
            error:   chargeCheck.message,
            code:    chargeCheck.code,
            details: chargeCheck.details,
          });
        }
      }
      // ─── End Gate B ─────────────────────────────────────────────────────

      // PR-TAX-1: Compute tax breakdown (non-fatal — never blocks booking creation)
      let taxData = { subtotal_amount: null, vat_amount: null, service_charge_amount: null, total_amount: null, tax_snapshot: null };
      const taxableAmount = charge_amount;
      if (taxableAmount != null && Number.isFinite(taxableAmount) && taxableAmount > 0) {
        try {
          const taxResult = await computeTaxForBooking({ tenantId: resolvedTenantId, serviceId: resolvedServiceId, chargedAmount: taxableAmount });
          taxData = { subtotal_amount: taxResult.subtotal, vat_amount: taxResult.vat_amount, service_charge_amount: taxResult.service_charge_amount, total_amount: taxResult.total, tax_snapshot: taxResult.snapshot };
        } catch (taxErr) {
          console.warn("taxEngine non-fatal error (booking create):", taxErr?.message || taxErr);
        }
      }

      // Derive payment_method for this booking
      // Membership/package/free are always derived server-side.
      // Cash is sent from client and trusted directly.
      // Card/Cliq: when sent alongside a networkPaymentOrderId (i.e., the result
      // page is creating the booking AFTER the gateway confirmed payment), trust
      // the client value. Without an orderId, card/cliq stay null (legacy path
      // where payment_method is updated post-capture by the gateway webhook).
      const payment_method = finalCustomerMembershipId
        ? 'membership'
        : prepaidApplied
          ? 'package'
          : (price_amount == null || price_amount === 0)
            ? 'free'
            : requestedPaymentMethod === 'cash'
              ? 'cash'
              : (requestedPaymentMethod === 'card' || requestedPaymentMethod === 'cliq') && networkPaymentOrderId
                ? requestedPaymentMethod  // PAY-FIX: trust card/cliq when order ID proves gateway payment
                : null;

      const hasMoneyCols = await ensureBookingMoneyColumns();
      const hasRateCols = await ensureBookingRateColumns();
      const hasPaymentMethodCol = await ensurePaymentMethodColumn(); // PAY-2

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

      // ── WhatsApp booking confirmation (non-fatal, fires after response) ──
      // Only send on new bookings (not replays), only when phone exists.
      // Runs after the response is built so it never delays the customer.
      // WA-1: tenantId passed so per-tenant DB credentials are used first.
      if (created && joined?.customer_phone) {
        setImmediate(async () => {
          try {
            const { sendBookingConfirmation, isWhatsAppConfigured } = require('../../utils/whatsapp');
            const { isWhatsAppEnabledForTenant } = require('../../utils/whatsappCredentials');
            // Check DB credentials first (WA-1), fall back to env var check
            const waEnabled = await isWhatsAppEnabledForTenant(resolvedTenantId).catch(() => isWhatsAppConfigured());
            if (!waEnabled) return;

            // Load tenant name + timezone for the message
            const tRes = await require('../../db').query('SELECT name, timezone FROM tenants WHERE id = $1', [resolvedTenantId]);
            const tenantName     = tRes.rows?.[0]?.name     || 'Flexrz';
            const tenantTimezone = tRes.rows?.[0]?.timezone || 'Asia/Amman';

            // Check for a pending payment link on this booking — include in confirmation if found
            let paymentUrl = null;
            let amountDue  = null;
            let currency   = joined.currency_code || 'JOD';
            try {
              const plRes = await require('../../db').query(
                `SELECT token, amount_requested, currency_code
                 FROM rental_payment_links
                 WHERE booking_id = $1
                   AND status = 'pending'
                   AND (expires_at IS NULL OR expires_at > NOW())
                 ORDER BY created_at DESC LIMIT 1`,
                [bookingId]
              );
              if (plRes.rows.length) {
              const frontendUrl = process.env.FRONTEND_URL || 'https://app.flexrz.com';
                paymentUrl = `${frontendUrl}/pay/${plRes.rows[0].token}`;
                amountDue  = plRes.rows[0].amount_requested;
                currency   = plRes.rows[0].currency_code || currency;
              }
            } catch (_plErr) { /* non-fatal — confirmation still sends without link */ }

            const waResult = await sendBookingConfirmation({
              booking: joined,
              tenantName,
              tenantTimezone,
              tenantId: resolvedTenantId,
              paymentUrl,
              amountDue,
              currency,
              bookingUrl: await (async () => {
                if (!joined.booking_code) return null;
                // Try to use the tenant's primary custom domain first
                try {
                  const domainRes = await require('../../db').query(
                    `SELECT domain FROM tenant_domains
                     WHERE tenant_id = $1 AND status = 'active' AND is_primary = TRUE
                     LIMIT 1`,
                    [resolvedTenantId]
                  );
                  if (domainRes.rows.length) {
                    const d = domainRes.rows[0].domain.replace(/\/$/, '');
                    const base = d.startsWith('http') ? d : `https://${d}`;
                    return `${base}?ref=${encodeURIComponent(joined.booking_code)}`;
                  }
                } catch (_) { /* non-fatal */ }
                // Fall back to standard booking URL
                const bookingBase = process.env.BOOKING_FRONTEND_URL || 'https://flexrz.com';
                return `${bookingBase}/book/${slug}?ref=${encodeURIComponent(joined.booking_code)}`;
              })(),
            });
            if (waResult.ok) {
              require('../../utils/logger').info({ bookingId, phone: joined.customer_phone, msgId: waResult.messageId, hasPaymentLink: !!paymentUrl }, 'WhatsApp confirmation sent');
            } else {
              require('../../utils/logger').warn({ bookingId, reason: waResult.reason }, 'WhatsApp confirmation skipped');
            }
          } catch (waErr) {
            // Non-fatal — log but never crash the booking response
            require('../../utils/logger').error({ err: waErr, bookingId }, 'WhatsApp confirmation error (non-fatal)');
          }
        });
      }
      // ── End WhatsApp ──────────────────────────────────────────────────────

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
