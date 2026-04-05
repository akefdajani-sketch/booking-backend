"use strict";

const express = require("express");
const db = require("../db");
const { pool } = require("../db");
const { getTenantBySlug } = require("../utils/tenants");
const { runSupportAgent, generateLandingCopy } = require("../utils/claudeService");
const requireAppAuth = require("../middleware/requireAppAuth");

const router = express.Router();

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
  // Services — use COALESCE for columns that may not exist in older schemas
  const hasDescription  = await columnExists("services", "description");
  const hasMaxParallel  = await columnExists("services", "max_parallel_bookings");
  const hasMinSlots     = await columnExists("services", "min_consecutive_slots");
  const hasAllowMem     = await columnExists("services", "allow_membership");
  const hasCategoryId   = await columnExists("services", "category_id");
  const hasPriceAmount  = await columnExists("services", "price_amount");

  const priceCol       = hasPriceAmount ? "COALESCE(s.price_amount, s.price)" : "s.price";
  const descCol        = hasDescription ? "s.description" : "NULL::text AS description";
  const parallelCol    = hasMaxParallel ? "s.max_parallel_bookings" : "NULL::int AS max_parallel_bookings";
  const minSlotsCol    = hasMinSlots    ? "s.min_consecutive_slots" : "NULL::int AS min_consecutive_slots";
  const allowMemCol    = hasAllowMem    ? "s.allow_membership" : "false AS allow_membership";
  const categoryCol    = hasCategoryId  ? "s.category_id" : "NULL::int AS category_id";

  const [servicesRes, membershipsRes, ratesRes, hoursRes, resourcesRes, staffRes, categoriesRes, packagesCheckRes] =
    await Promise.all([
      db.query(
        `SELECT s.id, s.name, ${descCol},
                s.duration_minutes, s.slot_interval_minutes,
                s.max_consecutive_slots, ${minSlotsCol},
                ${priceCol} AS price, s.currency_code,
                ${parallelCol}, ${allowMemCol}, ${categoryCol}
         FROM services s
         WHERE s.tenant_id = $1 AND COALESCE(s.is_active, true) = true
           AND COALESCE(s.deleted_at IS NULL, true)
         ORDER BY s.name ASC`,
        [tenantId]
      ),

      db.query(
        `SELECT id, name, description, billing_type, price, currency,
                included_minutes, included_uses, validity_days, is_active
         FROM membership_plans
         WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
         ORDER BY name ASC`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      db.query(
        `SELECT r.name, r.price_type, r.amount, r.currency_code,
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

  // Check which columns exist in bookings
  const hasDeletedAt   = await columnExists("bookings", "deleted_at");
  const hasPriceAmount = await columnExists("bookings", "price_amount");
  const hasChargeAmt   = await columnExists("bookings", "charge_amount");
  const hasCurrCode    = await columnExists("bookings", "currency_code");
  const hasPayMethod   = await columnExists("bookings", "payment_method");

  const priceCol   = hasPriceAmount ? "b.price_amount"  : "NULL::numeric AS price_amount";
  const chargeCol  = hasChargeAmt   ? "b.charge_amount" : "NULL::numeric AS charge_amount";
  const currCol    = hasCurrCode    ? "b.currency_code" : "NULL::text AS currency_code";
  const payCol     = hasPayMethod   ? "b.payment_method": "NULL::text AS payment_method";
  const deleteWhere= hasDeletedAt   ? "AND b.deleted_at IS NULL" : "";

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
      `SELECT b.id, b.status, b.start_time, b.end_time,
              b.duration_minutes, ${priceCol}, ${chargeCol},
              ${currCol}, ${payCol},
              s.name AS service_name, s.id AS service_id,
              r.name AS resource_name, st.name AS staff_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN resources r ON r.id = b.resource_id
       LEFT JOIN staff st ON st.id = b.staff_id
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
        const url = `http://localhost:${process.env.PORT || 5000}/api/availability?tenantSlug=${tenantSlug}&serviceId=${action.service_id}&date=${action.date}`;
        const res = await fetch(url);
        const data = await res.json();
        const available = (data.slots || data.times || []).filter(s => s.is_available !== false);
        if (available.length === 0) return { success: true, slots: [], message: `No available slots on ${action.date} for this service.` };
        return { success: true, slots: available.slice(0, 10), message: null };
      } catch (e) {
        return { success: false, message: "Could not fetch availability right now." };
      }
    }

    case "create_booking": {
      if (!customerId) return { success: false, message: "You need to be signed in to book." };
      if (!action.service_id || !action.start_time) {
        return { success: false, message: "Need service and start time to create a booking." };
      }

      try {
        // Get service details for duration
        const svcRes = await db.query(
          `SELECT id, name, duration_minutes, slot_interval_minutes
           FROM services WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          [action.service_id, tenantId]
        );
        if (svcRes.rows.length === 0) return { success: false, message: "Service not found." };
        const svc = svcRes.rows[0];

        const duration = action.duration_minutes || svc.slot_interval_minutes || svc.duration_minutes;

        const url = `http://localhost:${process.env.PORT || 5000}/api/bookings`;
        const payload = {
          tenantSlug,
          serviceId: action.service_id,
          startTime: action.start_time,
          durationMinutes: duration,
          resourceId: action.resource_id || null,
          staffId: action.staff_id || null,
          customerMembershipId: action.membership_id || null,
          autoConsumeMembership: action.membership_id ? true : false,
        };

        const bookingRes = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": authToken ? `Bearer ${authToken}` : "",
          },
          body: JSON.stringify(payload),
        });

        const bookingData = await bookingRes.json();
        if (!bookingRes.ok) {
          return { success: false, message: bookingData.error || "Booking failed. Please try again." };
        }

        return {
          success: true,
          booking: bookingData,
          message: `✅ Your booking for ${svc.name} on ${new Date(action.start_time).toLocaleString()} has been confirmed! Booking ID: #${bookingData.id || bookingData.booking?.id}`,
        };
      } catch (e) {
        console.error("[AI create_booking error]", e);
        return { success: false, message: "Could not create booking right now. Please try via the booking form." };
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

    const { reply, action } = await runSupportAgent({
      tenantContext: { ...tenant, ...businessContext },
      customerData,
      isSignedIn,
      history,
      message,
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

    const finalReply = actionResult?.message
      ? `${reply}\n\n${actionResult.message}`
      : reply;

    res.json({
      reply: finalReply,
      action: actionResult,
      // Return slots so frontend can render them
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
