"use strict";

const express = require("express");
const db = require("../db");
const { getTenantBySlug } = require("../utils/tenants");
const { runSupportAgent, generateLandingCopy } = require("../utils/claudeService");
const requireAppAuth = require("../middleware/requireAppAuth");
const maybeEnsureUser = require("../middleware/maybeEnsureUser");

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────

async function fetchBusinessContext(tenantId) {
  const [servicesResult, membershipsResult, ratesResult, hoursResult] = await Promise.all([
    db.query(
      `SELECT id, name, description, duration_minutes, price_amount AS price,
              max_consecutive_slots, max_parallel_bookings, slot_interval_minutes
       FROM services
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY name ASC`,
      [tenantId]
    ),
    db.query(
      `SELECT id, name, description, billing_type, price, currency,
              included_minutes, included_uses, validity_days
       FROM membership_plans
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY name ASC`,
      [tenantId]
    ),
    db.query(
      `SELECT r.name, r.price_type, r.amount, r.currency_code,
              r.days_of_week, r.time_start, r.time_end,
              r.date_start, r.date_end, r.min_duration_mins, r.max_duration_mins,
              r.require_any_membership, r.require_any_prepaid,
              s.name AS service_name, mp.name AS membership_name
       FROM rate_rules r
       LEFT JOIN services s ON s.id = r.service_id
       LEFT JOIN membership_plans mp ON mp.id = r.membership_plan_id
       WHERE r.tenant_id = $1 AND COALESCE(r.is_active, false) = true
       ORDER BY r.priority DESC NULLS LAST, r.name ASC`,
      [tenantId]
    ),
    db.query(
      `SELECT day_of_week, open_time, close_time, is_open
       FROM tenant_hours
       WHERE tenant_id = $1
       ORDER BY day_of_week ASC`,
      [tenantId]
    ).catch(() => ({ rows: [] })), // graceful fallback if table missing
  ]);

  return {
    services: servicesResult.rows,
    memberships: membershipsResult.rows,
    rates: ratesResult.rows,
    workingHours: hoursResult.rows,
  };
}

async function fetchCustomerData(tenantId, email) {
  if (!email) return null;

  // Get customer profile
  const profileRes = await db.query(
    `SELECT id, name, email, phone, created_at
     FROM customers
     WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)
     LIMIT 1`,
    [tenantId, email]
  );

  if (profileRes.rows.length === 0) return null;
  const customer = profileRes.rows[0];
  const customerId = customer.id;

  // Fetch all customer data in parallel
  const [bookingsRes, membershipsRes, packagesRes] = await Promise.all([

    // Bookings with service name
    db.query(
      `SELECT b.id, b.status, b.start_time, b.duration_minutes,
              b.price_amount, b.currency_code, b.notes,
              s.name AS service_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       WHERE b.tenant_id = $1 AND b.customer_id = $2
         AND COALESCE(b.deleted_at IS NULL, true)
       ORDER BY b.start_time DESC
       LIMIT 50`,
      [tenantId, customerId]
    ),

    // Active memberships with plan name and balance
    db.query(
      `SELECT cm.id, cm.status, cm.started_at, cm.end_at,
              cm.minutes_remaining, cm.uses_remaining,
              mp.name AS plan_name, mp.included_minutes, mp.included_uses
       FROM customer_memberships cm
       LEFT JOIN membership_plans mp ON mp.id = cm.plan_id
       WHERE cm.tenant_id = $1 AND cm.customer_id = $2
       ORDER BY cm.started_at DESC
       LIMIT 10`,
      [tenantId, customerId]
    ).catch(() => ({ rows: [] })),

    // Prepaid packages
    db.query(
      `SELECT e.id, e.status, e.remaining_quantity, e.original_quantity,
              e.starts_at, e.expires_at,
              pp.name AS product_name
       FROM customer_prepaid_entitlements e
       LEFT JOIN prepaid_products pp ON pp.id = e.prepaid_product_id
       WHERE e.tenant_id = $1 AND e.customer_id = $2
       ORDER BY e.created_at DESC
       LIMIT 10`,
      [tenantId, customerId]
    ).catch(() => ({ rows: [] })),
  ]);

  return {
    profile: customer,
    bookings: bookingsRes.rows,
    memberships: membershipsRes.rows,
    packages: packagesRes.rows,
  };
}

// ── Action handler ────────────────────────────────────────────────────

async function handleAction(action, tenantId, customerId) {
  if (!action || !customerId) return null;

  switch (action.type) {
    case "cancel_booking": {
      if (!action.booking_id) return { success: false, message: "No booking ID provided." };

      // Verify booking belongs to this customer + tenant
      const check = await db.query(
        `SELECT id, status FROM bookings
         WHERE id = $1 AND tenant_id = $2 AND customer_id = $3 LIMIT 1`,
        [action.booking_id, tenantId, customerId]
      );
      if (check.rows.length === 0) return { success: false, message: "Booking not found." };
      if (check.rows[0].status === "cancelled") return { success: false, message: "Already cancelled." };

      await db.query(
        `UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
        [action.booking_id]
      );
      return { success: true, message: `Booking #${action.booking_id} has been cancelled.` };
    }

    case "check_balance":
    case "view_bookings":
      // These are handled by Claude reading the customer data — no DB write needed
      return { success: true, message: null };

    default:
      return null;
  }
}

// ── POST /api/ai/:tenantSlug/chat ─────────────────────────────────────
router.post("/:tenantSlug/chat", maybeEnsureUser, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    const tenant = await getTenantBySlug(req.params.tenantSlug);

    // Fetch business context (always)
    const businessContext = await fetchBusinessContext(tenant.id);

    // Fetch customer data only if signed in
    const email = req.auth?.email || req.googleUser?.email || null;
    const isSignedIn = !!email;
    const customerData = isSignedIn ? await fetchCustomerData(tenant.id, email) : null;

    const { reply, action } = await runSupportAgent({
      tenantContext: { ...tenant, ...businessContext },
      customerData,
      isSignedIn,
      history,
      message,
    });

    // Execute any action Claude decided to take
    let actionResult = null;
    if (action && customerData?.profile?.id) {
      actionResult = await handleAction(action, tenant.id, customerData.profile.id);
    }

    // If action produced a message, append it to reply
    const finalReply = actionResult?.message
      ? `${reply}\n\n✅ ${actionResult.message}`
      : reply;

    res.json({ reply: finalReply, action: actionResult });
  } catch (err) {
    if (err.code === "TENANT_NOT_FOUND") {
      return res.status(404).json({ error: "Tenant not found" });
    }
    console.error("[AI chat error]", err);
    res.status(500).json({ error: "AI unavailable, please try again" });
  }
});

// ── POST /api/ai/:tenantSlug/generate-landing ─────────────────────────
router.post("/:tenantSlug/generate-landing", async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.tenantSlug);
    const { services, memberships } = await fetchBusinessContext(tenant.id);
    const copy = await generateLandingCopy({ tenant, services, memberships });
    res.json(copy);
  } catch (err) {
    if (err.code === "TENANT_NOT_FOUND") {
      return res.status(404).json({ error: "Tenant not found" });
    }
    console.error("[Landing gen error]", err);
    res.status(500).json({ error: "Generation failed, please try again" });
  }
});

module.exports = router;
