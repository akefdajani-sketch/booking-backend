"use strict";

const express = require("express");
const db = require("../db");
const { pool } = require("../db");
const { getTenantBySlug } = require("../utils/tenants");
const { runSupportAgent, generateLandingCopy } = require("../utils/claudeService");
const requireAppAuth = require("../middleware/requireAppAuth");

const router = express.Router();
// Detect when user is confirming a previously discussed booking
function isConfirmationMessage(msg) {
  if (!msg) return false;
  const t = msg.toLowerCase().replace(/[!.?]/g, "").trim();
  const patterns = [
    "yes", "yeah", "yep", "sure", "ok", "okay", "confirm", "confirmed",
    "go ahead", "book it", "do it", "please", "yes please", "yes confirm",
    "create it", "make it", "perfect", "great", "correct", "that works",
    "lets do it", "yes go ahead", "please do", "yes confirm it"
  ];
  // Also match emoji-suffixed versions like "Yes, confirm it checkmark"
  const clean = t.replace(/[^a-z ,]/g, "").trim();
  return patterns.some(p => clean === p || clean.startsWith(p + " ") || clean === "yes confirm it");
}


// ── Optional auth — sets req.googleUser/req.auth when token present, never blocks ──
function optionalAuth(req, res, next) {
  const hasAuth =
    !!req.headers.authorization ||
    !!req.headers["x-user-email"] ||
    !!(req.cookies && (req.cookies.bf_session || req.cookies["next-auth.session-token"] || req.cookies["__Secure-next-auth.session-token"]));

  if (!hasAuth) return next();

  requireAppAuth(req, res, (err) => {
    if (err) { req.googleUser = null; req.auth = null; }
    next();
  });
}

// ── Safe column check ─────────────────────────────────────────────────
async function columnExists(table, column) {
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
      [table, column]
    );
    return r.rows.length > 0;
  } catch { return false; }
}

// ── Fetch full business context ───────────────────────────────────────
async function fetchBusinessContext(tenantId, tenantSlug) {
  // Check every column before using it — schema varies between installs
  const [
    hasDescription, hasMaxParallel, hasMinSlots, hasAllowMem,
    hasCategoryId, hasPriceAmount, hasPrice, hasCurrencyCode,
    hasSlotInterval, hasMaxConsec, hasDeletedAt,
    // membership_plans columns
    hasMpBillingType, hasMpIncMins, hasMpIncUses, hasMpValidity,
    hasMpCurrency, hasMpDescription,
    // services allow_membership
  ] = await Promise.all([
    columnExists("services", "description"),
    columnExists("services", "max_parallel_bookings"),
    columnExists("services", "min_consecutive_slots"),
    columnExists("services", "allow_membership"),
    columnExists("services", "category_id"),
    columnExists("services", "price_amount"),
    columnExists("services", "price"),
    columnExists("services", "currency_code"),
    columnExists("services", "slot_interval_minutes"),
    columnExists("services", "max_consecutive_slots"),
    columnExists("services", "deleted_at"),
    columnExists("membership_plans", "billing_type"),
    columnExists("membership_plans", "included_minutes"),
    columnExists("membership_plans", "included_uses"),
    columnExists("membership_plans", "validity_days"),
    columnExists("membership_plans", "currency"),
    columnExists("membership_plans", "description"),
  ]);

  const priceCol      = hasPriceAmount && hasPrice ? "COALESCE(s.price_amount, s.price)"
                      : hasPriceAmount ? "s.price_amount"
                      : hasPrice ? "s.price"
                      : "NULL::numeric";
  const currCol       = hasCurrencyCode  ? "s.currency_code"         : "NULL::text AS currency_code";
  const descCol       = hasDescription   ? "s.description"           : "NULL::text AS description";
  const parallelCol   = hasMaxParallel   ? "s.max_parallel_bookings" : "NULL::int AS max_parallel_bookings";
  const minSlotsCol   = hasMinSlots      ? "s.min_consecutive_slots" : "NULL::int AS min_consecutive_slots";
  const allowMemCol   = hasAllowMem      ? "s.allow_membership"      : "false AS allow_membership";
  const categoryCol   = hasCategoryId    ? "s.category_id"           : "NULL::int AS category_id";
  const slotIntCol    = hasSlotInterval  ? "s.slot_interval_minutes" : "NULL::int AS slot_interval_minutes";
  const maxConsecCol  = hasMaxConsec     ? "s.max_consecutive_slots" : "NULL::int AS max_consecutive_slots";
  const deletedWhere  = hasDeletedAt     ? "AND s.deleted_at IS NULL" : "";

  // membership_plans safe columns
  const mpBillingCol  = hasMpBillingType ? "billing_type"    : "NULL::text AS billing_type";
  const mpIncMinsCol  = hasMpIncMins     ? "included_minutes": "NULL::int AS included_minutes";
  const mpIncUsesCol  = hasMpIncUses     ? "included_uses"   : "NULL::int AS included_uses";
  const mpValidityCol = hasMpValidity    ? "validity_days"   : "NULL::int AS validity_days";
  const mpCurrencyCol = hasMpCurrency    ? "currency"        : "NULL::text AS currency";
  const mpDescCol     = hasMpDescription ? "description"     : "NULL::text AS description";

  const [servicesRes, membershipsRes, ratesRes, hoursRes, resourcesRes, staffRes, categoriesRes, packagesCheckRes, resourceLinksRes, staffLinksRes] =
    await Promise.all([
      db.query(
        `SELECT s.id, s.name, ${descCol},
                s.duration_minutes, ${slotIntCol},
                ${maxConsecCol}, ${minSlotsCol},
                ${priceCol} AS price, ${currCol},
                ${parallelCol}, ${allowMemCol}, ${categoryCol}
         FROM services s
         WHERE s.tenant_id = $1 AND COALESCE(s.is_active, true) = true
           ${deletedWhere}
         ORDER BY s.name ASC`,
        [tenantId]
      ),

      db.query(
        `SELECT id, name, ${mpDescCol}, ${mpBillingCol}, price,
                ${mpCurrencyCol}, ${mpIncMinsCol}, ${mpIncUsesCol},
                ${mpValidityCol}, is_active
         FROM membership_plans
         WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
         ORDER BY name ASC`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      db.query(
        `SELECT r.id, r.name, r.price_type, r.amount, r.currency_code,
                r.days_of_week, r.time_start, r.time_end,
                r.date_start, r.date_end,
                r.min_duration_mins, r.max_duration_mins,
                r.priority, r.require_any_membership, r.require_any_prepaid,
                s.name AS service_name, s.id AS service_id,
                mp.name AS membership_name
         FROM rate_rules r
         LEFT JOIN services s ON s.id = r.service_id
         LEFT JOIN membership_plans mp ON mp.id = r.membership_plan_id
         WHERE r.tenant_id = $1 AND COALESCE(r.is_active, false) = true
         ORDER BY r.priority DESC NULLS LAST, r.name ASC`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      db.query(
        `SELECT day_of_week, open_time, close_time, is_closed
         FROM tenant_hours
         WHERE tenant_id = $1
         ORDER BY day_of_week ASC`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      db.query(
        `SELECT id, name, capacity, is_active
         FROM resources
         WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
         ORDER BY name ASC`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      db.query(
        `SELECT id, name, email, is_active
         FROM staff
         WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
         ORDER BY name ASC`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      db.query(
        `SELECT id, name, description, color
         FROM service_categories
         WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
         ORDER BY display_order ASC, name ASC`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      // Check if prepaid tables exist
      db.query(
        `SELECT to_regclass('public.prepaid_products') AS prod`
      ).catch(() => ({ rows: [{ prod: null }] })),

      // Resource ↔ Service links (which simulators/rooms work with which services)
      db.query(
        `SELECT rsl.resource_id, rsl.service_id,
                r.name AS resource_name, s.name AS service_name
         FROM resource_service_links rsl
         JOIN resources r ON r.id = rsl.resource_id
         JOIN services s ON s.id = rsl.service_id
         WHERE rsl.tenant_id = $1`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      // Staff ↔ Service links (which staff can do which services)
      db.query(
        `SELECT ssl.staff_id, ssl.service_id,
                st.name AS staff_name, s.name AS service_name
         FROM staff_service_links ssl
         JOIN staff st ON st.id = ssl.staff_id
         JOIN services s ON s.id = ssl.service_id
         WHERE ssl.tenant_id = $1`,
        [tenantId]
      ).catch(() => ({ rows: [] })),
    ]);

  const hasPrePaid = !!packagesCheckRes.rows?.[0]?.prod;

  let prepaidProducts = [];
  if (hasPrePaid) {
    const pRes = await db.query(
      `SELECT id, name, description, product_type, price,
              session_count, minutes_total, credit_amount
       FROM prepaid_products
       WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
       ORDER BY name ASC`,
      [tenantId]
    ).catch(() => ({ rows: [] }));
    prepaidProducts = pRes.rows;
  }

  return {
    services: servicesRes.rows,
    memberships: membershipsRes.rows,
    rates: ratesRes.rows,
    workingHours: hoursRes.rows,
    resources: resourcesRes.rows,
    staff: staffRes.rows,
    categories: categoriesRes.rows,
    prepaidProducts,
    resourceLinks: resourceLinksRes.rows,   // resource ↔ service mappings
    staffLinks: staffLinksRes.rows,         // staff ↔ service mappings
  };
}

// ── Fetch full customer data ──────────────────────────────────────────
async function fetchCustomerData(tenantId, email) {
  if (!email) return null;

  const profileRes = await db.query(
    `SELECT id, name, email, phone, notes, created_at
     FROM customers
     WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)
     LIMIT 1`,
    [tenantId, email]
  );
  if (profileRes.rows.length === 0) return null;

  const customer = profileRes.rows[0];
  const customerId = customer.id;

  // Check which columns exist in bookings — run all in parallel
  const [
    bHasDeletedAt, bHasPriceAmount, bHasChargeAmt, bHasCurrCode,
    bHasPayMethod, bHasEndTime, bHasDuration, bHasResourceId, bHasStaffId,
  ] = await Promise.all([
    columnExists("bookings", "deleted_at"),
    columnExists("bookings", "price_amount"),
    columnExists("bookings", "charge_amount"),
    columnExists("bookings", "currency_code"),
    columnExists("bookings", "payment_method"),
    columnExists("bookings", "end_time"),
    columnExists("bookings", "duration_minutes"),
    columnExists("bookings", "resource_id"),
    columnExists("bookings", "staff_id"),
  ]);

  const priceCol   = bHasPriceAmount ? "b.price_amount"    : "NULL::numeric AS price_amount";
  const chargeCol  = bHasChargeAmt   ? "b.charge_amount"   : "NULL::numeric AS charge_amount";
  const currCol    = bHasCurrCode    ? "b.currency_code"   : "NULL::text AS currency_code";
  const payCol     = bHasPayMethod   ? "b.payment_method"  : "NULL::text AS payment_method";
  const endCol     = bHasEndTime     ? "b.end_time"        : "NULL::timestamptz AS end_time";
  const durCol     = bHasDuration    ? "b.duration_minutes": "NULL::int AS duration_minutes";
  const deleteWhere= bHasDeletedAt   ? "AND b.deleted_at IS NULL" : "";
  const resJoin    = bHasResourceId  ? "LEFT JOIN resources r ON r.id = b.resource_id" : "";
  const staffJoin  = bHasStaffId     ? "LEFT JOIN staff st ON st.id = b.staff_id" : "";
  const resName    = bHasResourceId  ? "r.name AS resource_name," : "NULL::text AS resource_name,";
  const staffName  = bHasStaffId     ? "st.name AS staff_name"    : "NULL::text AS staff_name";

  // Check customer_memberships columns
  const cmHasPlanId     = await columnExists("customer_memberships", "plan_id");
  const cmHasMembPlanId = await columnExists("customer_memberships", "membership_plan_id");
  const planIdCol = cmHasPlanId ? "cm.plan_id" : cmHasMembPlanId ? "cm.membership_plan_id" : "NULL::int";

  const cmHasStartAt    = await columnExists("customer_memberships", "start_at");
  const cmHasStartedAt  = await columnExists("customer_memberships", "started_at");
  const startAtCol      = cmHasStartAt ? "cm.start_at" : cmHasStartedAt ? "cm.started_at" : "cm.created_at";

  const cmHasEndAt      = await columnExists("customer_memberships", "end_at");
  const cmHasExpiresAt  = await columnExists("customer_memberships", "expires_at");
  const endAtCol        = cmHasEndAt ? "cm.end_at" : cmHasExpiresAt ? "cm.expires_at" : "NULL::timestamptz";

  const cmHasMinRem = await columnExists("customer_memberships", "minutes_remaining");
  const cmHasUseRem = await columnExists("customer_memberships", "uses_remaining");
  const minRemCol   = cmHasMinRem ? "cm.minutes_remaining" : "NULL::int AS minutes_remaining";
  const useRemCol   = cmHasUseRem ? "cm.uses_remaining"    : "NULL::int AS uses_remaining";

  const [bookingsRes, membershipsRes, packagesRes] = await Promise.all([
    db.query(
      `SELECT b.id, b.status, b.start_time, ${endCol},
              ${durCol}, ${priceCol}, ${chargeCol},
              ${currCol}, ${payCol},
              s.name AS service_name, s.id AS service_id,
              ${resName} ${staffName}
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       ${resJoin}
       ${staffJoin}
       WHERE b.tenant_id = $1 AND b.customer_id = $2
         ${deleteWhere}
       ORDER BY b.start_time DESC
       LIMIT 50`,
      [tenantId, customerId]
    ),

    db.query(
      `SELECT cm.id, cm.status,
              ${planIdCol} AS plan_id,
              ${startAtCol} AS started_at,
              ${endAtCol} AS end_at,
              ${minRemCol}, ${useRemCol},
              mp.name AS plan_name,
              mp.included_minutes, mp.included_uses,
              mp.billing_type, mp.validity_days
       FROM customer_memberships cm
       LEFT JOIN membership_plans mp ON mp.id = ${planIdCol}
       WHERE cm.tenant_id = $1 AND cm.customer_id = $2
       ORDER BY ${startAtCol} DESC NULLS LAST
       LIMIT 10`,
      [tenantId, customerId]
    ).catch(() => ({ rows: [] })),

    // Prepaid packages — check if table exists first
    (async () => {
      const check = await db.query(
        `SELECT to_regclass('public.customer_prepaid_entitlements') AS ent`
      ).catch(() => ({ rows: [{ ent: null }] }));
      if (!check.rows?.[0]?.ent) return { rows: [] };
      return db.query(
        `SELECT e.id, e.status, e.remaining_quantity, e.original_quantity,
                e.starts_at, e.expires_at,
                p.name AS product_name, p.product_type,
                p.session_count, p.minutes_total, p.credit_amount
         FROM customer_prepaid_entitlements e
         LEFT JOIN prepaid_products p ON p.id = e.prepaid_product_id
         WHERE e.tenant_id = $1 AND e.customer_id = $2
         ORDER BY e.created_at DESC
         LIMIT 10`,
        [tenantId, customerId]
      ).catch(() => ({ rows: [] }));
    })(),
  ]);

  return {
    profile: customer,
    bookings: bookingsRes.rows,
    memberships: membershipsRes.rows,
    packages: packagesRes.rows,
  };
}

// ── Execute actions ───────────────────────────────────────────────────
async function handleAction(action, tenantId, tenantSlug, customerId, customerEmail, authToken) {
  if (!action) return null;

  switch (action.type) {

    case "cancel_booking": {
      if (!action.booking_id) return { success: false, message: "No booking ID specified." };
      if (!customerId) return { success: false, message: "You need to be signed in to cancel bookings." };

      const check = await db.query(
        `SELECT id, status, start_time FROM bookings
         WHERE id = $1 AND tenant_id = $2 AND customer_id = $3 LIMIT 1`,
        [action.booking_id, tenantId, customerId]
      );
      if (check.rows.length === 0) return { success: false, message: "Booking not found on your account." };
      const booking = check.rows[0];
      if (booking.status === "cancelled") return { success: false, message: "This booking is already cancelled." };

      // Don't cancel past bookings
      if (new Date(booking.start_time) < new Date()) {
        return { success: false, message: "Cannot cancel a booking that has already passed." };
      }

      await db.query(
        `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [action.booking_id]
      );
      return { success: true, message: `Booking #${action.booking_id} has been cancelled successfully.` };
    }

    case "check_availability": {
      if (!action.service_id || !action.date) {
        return { success: false, message: "Need service and date to check availability." };
      }
      try {
        const { buildAvailabilitySlots, normalizeDateInput } = require("../utils/availabilityEngine");

        // Get full service details (SELECT * needed for requires_resource, availability_basis etc.)
        const svcRes = await db.query(
          `SELECT * FROM services WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          [action.service_id, tenantId]
        );
        if (svcRes.rows.length === 0) return { success: false, message: "Service not found." };
        const service = svcRes.rows[0];

        // Get tenant timezone
        const tzRes = await db.query(`SELECT timezone FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
        const tenantTz = tzRes.rows?.[0]?.timezone || "UTC";

        // Auto-pick resource if not provided
        // Try resource_service_links first (explicit link), then any resource for tenant
        let resourceId = action.resource_id ? Number(action.resource_id) : null;
        if (!resourceId) {
          // Try linked resources first
          const linkedRes = await db.query(
            `SELECT r.id FROM resources r
             JOIN resource_service_links rsl ON rsl.resource_id = r.id
             WHERE rsl.service_id = $1 AND r.tenant_id = $2
               AND COALESCE(r.is_active, true) = true
             ORDER BY r.id ASC LIMIT 1`,
            [action.service_id, tenantId]
          ).catch(() => ({ rows: [] }));

          if (linkedRes.rows.length > 0) {
            resourceId = Number(linkedRes.rows[0].id);
          } else {
            // Fall back to any active resource for this tenant
            const anyRes = await db.query(
              `SELECT id FROM resources
               WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
               ORDER BY id ASC LIMIT 1`,
              [tenantId]
            ).catch(() => ({ rows: [] }));
            if (anyRes.rows.length > 0) resourceId = Number(anyRes.rows[0].id);
          }
        }

        const normalizedDate = normalizeDateInput(action.date);
        console.log(`[AI availability] service=${action.service_id} date=${normalizedDate} resourceId=${resourceId} basis=${service.availability_basis}`);

        const result = await buildAvailabilitySlots({
          tenantId,
          tenantSlug,
          date: normalizedDate,
          serviceId: Number(action.service_id),
          staffId: action.staff_id ? Number(action.staff_id) : null,
          resourceId,
          tenantTz,
          service,
        });

        const reason = result.meta?.reason;
        console.log(`[AI availability] reason=${reason} totalSlots=${(result.slots||[]).length}`);

        if (reason && reason !== "ok" && reason !== "success") {
          const reasonMap = {
            tenant_closed: "The business is closed on that day.",
            resource_required: "This service requires a specific resource selection.",
            staff_required: "This service requires staff selection.",
            no_working_hours: "No working hours configured for that day.",
            invalid_working_hours: "Working hours configuration issue.",
          };
          return {
            success: true, slots: [],
            message: reasonMap[reason] || `No slots available (${reason.replace(/_/g, " ")}).`,
          };
        }

        const allSlots = result.slots || result.times || [];
        const available = allSlots.filter(s => s.is_available !== false && s.available !== false);

        if (available.length === 0) {
          return { success: true, slots: [], message: `No available slots on ${action.date}. The business may be closed or fully booked.` };
        }
        return { success: true, slots: available.slice(0, 20), resourceId, message: null };
      } catch (e) {
        console.error("[AI check_availability error]", e);
        return { success: false, message: "Could not fetch availability right now." };
      }
    }

    case "create_booking": {
      if (!customerId) return { success: false, message: "You need to be signed in to book." };
      if (!action.service_id || !action.start_time) {
        return { success: false, message: "Need service and start time to create a booking." };
      }

      // Card/Cliq payments need the payment gateway UI — AI can only handle membership/cash/package
      const requestedPayMethod = action.payment_method || null;
      if (requestedPayMethod === "card" || requestedPayMethod === "cliq") {
        return {
          success: false, requiresUI: true,
          message: "Card and Cliq payments need to go through the secure payment page. Please use the **Book now** button and select the same slot!",
        };
      }

      try {
        const svcRes = await db.query(
          `SELECT * FROM services WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          [action.service_id, tenantId]
        );
        if (svcRes.rows.length === 0) return { success: false, message: "Service not found." };
        const svc = svcRes.rows[0];

        const slotInterval = svc.slot_interval_minutes || svc.duration_minutes || 60;
        const slots = action.slots || 1;
        const duration = action.duration_minutes || (slotInterval * slots);

        const start = new Date(action.start_time);
        if (isNaN(start.getTime())) return { success: false, message: "Invalid start time." };

        // Determine payment method:
        // 1. membership credits (customerMembershipId)
        // 2. prepaid package (prepaidEntitlementId)
        // 3. cash (default)
        const membershipId = action.membership_id ? Number(action.membership_id) : null;
        const prepaidId = action.prepaid_entitlement_id ? Number(action.prepaid_entitlement_id) : null;

        let paymentMethod = "cash";
        if (membershipId) paymentMethod = "membership";
        else if (prepaidId) paymentMethod = "package";

        console.log(`[AI create_booking] tenant=${tenantId} service=${svc.name} start=${start.toISOString()} duration=${duration} resource=${action.resource_id} payment=${paymentMethod} membership=${membershipId} prepaid=${prepaidId}`);

        const backendUrl = (process.env.RENDER_EXTERNAL_URL || "https://booking-backend-6jbc.onrender.com").replace(/\/$/, "");

        const payload = {
          tenantSlug,
          serviceId: action.service_id,
          startTime: start.toISOString(),
          durationMinutes: duration,
          resourceId: action.resource_id || null,
          staffId: action.staff_id || null,
          // Membership
          customerMembershipId: membershipId || null,
          autoConsumeMembership: !!membershipId,
          // Package / prepaid
          prepaidEntitlementId: prepaidId || null,
          autoConsumePrepaid: !!prepaidId,
          // Payment method
          paymentMethod,
        };

        const bookingRes = await fetch(`${backendUrl}/api/bookings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": authToken ? `Bearer ${authToken}` : "",
          },
          body: JSON.stringify(payload),
        });

        const bookingText = await bookingRes.text();
        let bookingData;
        try { bookingData = JSON.parse(bookingText); } catch { bookingData = {}; }
        console.log(`[AI create_booking] status=${bookingRes.status} body=${bookingText.slice(0, 600)}`);

        if (!bookingRes.ok) {
          const errMsg = bookingData?.error || bookingData?.message || "Booking failed.";

          // Handle membership-specific errors gracefully
          if (bookingRes.status === 409 && bookingData?.insufficientBalance) {
            return { success: false, message: `Not enough membership balance. You have ${bookingData.balanceBefore ?? "?"} min remaining but need ${duration} min. Try paying cash instead, or use the booking form.` };
          }
          if (bookingRes.status === 409 && bookingData?.conflictingBookings) {
            return { success: false, message: "That slot is no longer available — it may have just been booked. Shall I check for other times?" };
          }
          return { success: false, message: `${errMsg} Please try the booking form if the problem continues.` };
        }

        const bookingId = bookingData?.booking?.id || bookingData?.id;
        const tzRes = await db.query(`SELECT timezone FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
        const tz = tzRes.rows?.[0]?.timezone || "Asia/Amman";
        const displayTime = start.toLocaleString("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "short" });

        let payLabel = "Cash at venue";
        if (paymentMethod === "membership") payLabel = "Membership credits ✓";
        else if (paymentMethod === "package") payLabel = "Prepaid package ✓";

        return {
          success: true,
          booking: bookingData,
          bookingId,
          message: `✅ **Booked!**\n- **Service:** ${svc.name}\n- **When:** ${displayTime}\n- **Duration:** ${duration} min\n- **Booking ref:** #${bookingId}\n- **Payment:** ${payLabel}`,
        };
      } catch (e) {
        console.error("[AI create_booking error]", e);
        return { success: false, message: "Could not create booking — please use the booking form directly." };
      }
    }

    default:
      return null;
  }
}

// ── POST /api/ai/:tenantSlug/chat ─────────────────────────────────────
router.post("/:tenantSlug/chat", optionalAuth, async (req, res) => {
  try {
    const { message, history = [], authToken: clientAuthToken } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    const tenant = await getTenantBySlug(req.params.tenantSlug);

    const [businessContext, email] = await Promise.all([
      fetchBusinessContext(tenant.id, tenant.slug),
      Promise.resolve(req.auth?.email || req.googleUser?.email || null),
    ]);

    const isSignedIn = !!email;
    const customerData = isSignedIn ? await fetchCustomerData(tenant.id, email) : null;

    // Get auth token for booking actions
    const authToken = clientAuthToken ||
      req.headers.authorization?.replace("Bearer ", "") ||
      req.cookies?.bf_session || null;

    const isConfirmation = isConfirmationMessage(message);
    const { reply, action } = await runSupportAgent({
      tenantContext: { ...tenant, ...businessContext },
      customerData,
      isSignedIn,
      history,
      message,
      confirmationMode: isConfirmation,
    });

    // Execute action if Claude requested one
    let actionResult = null;
    if (action) {
      actionResult = await handleAction(
        action,
        tenant.id,
        tenant.slug,
        customerData?.profile?.id || null,
        email,
        authToken
      );
    }

    // If an action was executed, send the results back to Claude for a follow-up response
    let finalReply = reply || "";
    if (action && actionResult) {
      let actionContext = "";

      if (action.type === "check_availability") {
        if (actionResult.success && actionResult.slots && actionResult.slots.length > 0) {
          const slotTimes = actionResult.slots
            .map(s => s.time || s.label)
            .filter(Boolean)
            .slice(0, 15)
            .join(", ");
          actionContext = `AVAILABILITY RESULT: Found ${actionResult.slots.length} available slots on ${action.date}: ${slotTimes}. The resource_id to use is ${actionResult.resourceId || action.resource_id || "auto-selected"}.`;
        } else if (actionResult.success) {
          actionContext = `AVAILABILITY RESULT: ${actionResult.message || `No available slots on ${action.date}.`}`;
        } else {
          actionContext = `AVAILABILITY RESULT: Failed — ${actionResult.message}`;
        }
      } else if (action.type === "create_booking") {
        actionContext = actionResult.success
          ? `BOOKING RESULT: ${actionResult.message}`
          : `BOOKING RESULT: Failed — ${actionResult.message}`;
      } else if (action.type === "cancel_booking") {
        actionContext = actionResult.success
          ? `CANCELLATION RESULT: ${actionResult.message}`
          : `CANCELLATION RESULT: Failed — ${actionResult.message}`;
      }

      if (actionContext) {
        try {
          const followUp = await runSupportAgent({
            tenantContext: { ...tenant, ...businessContext },
            customerData,
            isSignedIn,
            history: [
              ...history,
              { role: "user", content: message },
              ...(reply ? [{ role: "assistant", content: reply }] : []),
              { role: "user", content: `[SYSTEM: ${actionContext}]` },
            ],
            message: actionContext,
          });
          if (followUp.reply) finalReply = followUp.reply;
        } catch (followUpErr) {
          console.error("[AI follow-up error]", followUpErr);
          if (actionResult.message) finalReply = actionResult.message;
        }
      }
    }

    // For successful bookings skip second Claude call - use message directly
    if (action?.type === "create_booking" && actionResult?.success) {
      finalReply = actionResult.message || "✅ Your booking has been confirmed!";
    }
    if (action?.type === "create_booking" && actionResult?.requiresUI) {
      finalReply = actionResult.message;
    }

    // Safety net - never return empty reply
    if (!finalReply || !finalReply.trim()) {
      finalReply = actionResult?.message || "I processed your request. Is there anything else I can help you with?";
    }

    res.json({
      reply: finalReply,
      action: actionResult,
      slots: actionResult?.slots || null,
    });
  } catch (err) {
    if (err.code === "TENANT_NOT_FOUND") return res.status(404).json({ error: "Tenant not found" });
    console.error("[AI chat error]", err);
    res.status(500).json({ error: "AI unavailable, please try again" });
  }
});

// ── POST /api/ai/:tenantSlug/generate-landing ─────────────────────────
router.post("/:tenantSlug/generate-landing", async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.tenantSlug);
    const { services, memberships } = await fetchBusinessContext(tenant.id, tenant.slug);
    const copy = await generateLandingCopy({ tenant, services, memberships });
    res.json(copy);
  } catch (err) {
    if (err.code === "TENANT_NOT_FOUND") return res.status(404).json({ error: "Tenant not found" });
    console.error("[Landing gen error]", err);
    res.status(500).json({ error: "Generation failed, please try again" });
  }
});

module.exports = router;
