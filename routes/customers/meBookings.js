// meBookings.js
// Customer self-service booking routes: GET /me/bookings, DELETE /me/bookings/:id
// Mounted by routes/customers.js

const express = require("express");
const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { getExistingColumns, firstExisting, pickCol, softDeleteClause, safeIntExpr, getErrorCode } = require("../../utils/customerQueryHelpers");


module.exports = function mount(router) {
router.get("/me/bookings", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });

    const cust = await pool.query(
      `SELECT id, name, email FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );

    if (cust.rows.length === 0) {
      // No customer record yet for this tenant -> empty history
      return res.json({ bookings: [] });
    }

    const customerId = cust.rows[0].id;

    // IMPORTANT: Postgres will ERROR if we reference a column that doesn't exist
    // (even inside COALESCE). So we dynamically pick the right columns at runtime.
    const startTime = await pickCol("bookings", "b", ["start_time", "start_at", "start_datetime"], "NULL");
    const endTime = await pickCol("bookings", "b", ["end_time", "end_at", "end_datetime"], "NULL");
    const duration = await pickCol(
      "bookings",
      "b",
      ["duration_minutes", "duration_mins", "duration"],
      `CASE
        WHEN ${endTime} IS NOT NULL AND ${startTime} IS NOT NULL
          THEN ROUND(EXTRACT(EPOCH FROM (${endTime} - ${startTime})) / 60.0)::int
        ELSE NULL
      END`
    );
    const status = await pickCol("bookings", "b", ["status"], "NULL");
    const createdAt = await pickCol("bookings", "b", ["created_at"], "NOW()");
    // Some DBs don't have notes; keep the response shape stable.
    const notes = await pickCol("bookings", "b", ["notes", "customer_notes"], "NULL");
    const serviceName = await pickCol("bookings", "b", ["service_name"], "NULL");
    const resourceName = await pickCol("bookings", "b", ["resource_name"], "NULL");

    // Newer DBs: invoice metadata + customer/staff fields.
    // Keep schema-tolerant via pickCol.
    const bookingCode = await pickCol("bookings", "b", ["booking_code"], "NULL");
    const customerName = await pickCol("bookings", "b", ["customer_name"], "NULL");
    const customerEmail = await pickCol("bookings", "b", ["customer_email"], "NULL");
    const customerPhone = await pickCol("bookings", "b", ["customer_phone"], "NULL");
    const staffName = await pickCol("bookings", "b", ["staff_name"], "NULL");

    // Financial fields — schema-tolerant (added in v1 hardened schema; may not
    // exist on older DB instances, so we use pickCol with NULL fallbacks).
    const priceAmount   = await pickCol("bookings", "b", ["price_amount"],          "NULL");
    const chargeAmount  = await pickCol("bookings", "b", ["charge_amount"],         "NULL");
    const currencyCode  = await pickCol("bookings", "b", ["currency_code"],         "NULL");
    const paymentMethod = await pickCol("bookings", "b", ["payment_method"],        "NULL");
    const rateRuleId    = await pickCol("bookings", "b", ["applied_rate_rule_id"],  "NULL");
    const rateSnapshot  = await pickCol("bookings", "b", ["applied_rate_snapshot"], "NULL");

    // RENTAL-1: nightly booking fields (schema-tolerant — NULL for time-slot bookings)
    const bookingMode   = await pickCol("bookings", "b", ["booking_mode"],  "'time_slots'");
    const checkinDate   = await pickCol("bookings", "b", ["checkin_date"],  "NULL");
    const checkoutDate  = await pickCol("bookings", "b", ["checkout_date"], "NULL");
    const nightsCount   = await pickCol("bookings", "b", ["nights_count"],  "NULL");
    const guestsCount   = await pickCol("bookings", "b", ["guests_count"],  "NULL");
    const addonsJson    = await pickCol("bookings", "b", ["addons_json"],   "NULL");
    const addonsTotal   = await pickCol("bookings", "b", ["addons_total"],  "NULL");

    const q = await pool.query(
      `
      SELECT
        b.id,
        b.tenant_id,
        b.customer_id,
        b.service_id,
        b.staff_id,
        b.resource_id,
        ${startTime} AS start_time,
        ${duration} AS duration_minutes,
        ${status} AS status,
        ${notes} AS notes,
        ${createdAt} AS created_at,
        ${bookingCode} AS booking_code,
        ${priceAmount}   AS price_amount,
        ${chargeAmount}  AS charge_amount,
        ${currencyCode}  AS currency_code,
        ${paymentMethod} AS payment_method,
        ${rateRuleId}    AS applied_rate_rule_id,
        ${rateSnapshot}  AS applied_rate_snapshot,
        rr.name          AS applied_rate_rule_name,
        b.customer_membership_id,
        mp.name AS membership_plan_name,
        cmem.minutes_remaining AS membership_minutes_remaining,
        cmem.uses_remaining AS membership_uses_remaining,
        mu.minutes_used AS membership_minutes_used_for_booking,
        mu.uses_used AS membership_uses_used_for_booking,
        COALESCE(pr.prepaid_applied, false) AS prepaid_applied,
        pr.prepaid_entitlement_id,
        pr.prepaid_product_id,
        pr.prepaid_product_name,
        pr.prepaid_redemption_id,
        pr.prepaid_redemption_mode,
        pr.prepaid_quantity_used,
        pr.prepaid_quantity_remaining,
        COALESCE(${customerName}, c.name) AS customer_name,
        COALESCE(${customerEmail}, c.email) AS customer_email,
        COALESCE(${customerPhone}, c.phone) AS customer_phone,
        COALESCE(s.name, ${serviceName}) AS service_name,
        COALESCE(st.name, ${staffName}) AS staff_name,
        COALESCE(r.name, ${resourceName}) AS resource_name,
        -- RENTAL-1: nightly fields
        ${bookingMode}  AS booking_mode,
        ${checkinDate}  AS checkin_date,
        ${checkoutDate} AS checkout_date,
        ${nightsCount}  AS nights_count,
        ${guestsCount}  AS guests_count,
        ${addonsJson}   AS addons_json,
        ${addonsTotal}  AS addons_total
      FROM bookings b
      LEFT JOIN customers c ON c.id = b.customer_id
      LEFT JOIN services s ON s.id = b.service_id
      LEFT JOIN staff st ON st.id = b.staff_id
      LEFT JOIN resources r ON r.id = b.resource_id
      LEFT JOIN customer_memberships cmem ON cmem.id = b.customer_membership_id
      LEFT JOIN membership_plans mp ON mp.id = cmem.plan_id
      LEFT JOIN rate_rules rr
        ON rr.tenant_id = b.tenant_id
       AND rr.id = b.applied_rate_rule_id
      LEFT JOIN LATERAL (
        SELECT
          SUM(CASE WHEN ml.minutes_delta < 0 THEN -ml.minutes_delta ELSE 0 END)::int AS minutes_used,
          SUM(CASE WHEN ml.uses_delta < 0 THEN -ml.uses_delta ELSE 0 END)::int AS uses_used
        FROM membership_ledger ml
        WHERE ml.booking_id = b.id
          AND (b.customer_membership_id IS NULL OR ml.customer_membership_id = b.customer_membership_id)
      ) mu ON true
      LEFT JOIN LATERAL (
        SELECT
          true AS prepaid_applied,
          pr.id AS prepaid_redemption_id,
          pr.entitlement_id AS prepaid_entitlement_id,
          pr.prepaid_product_id,
          pp.name AS prepaid_product_name,
          pr.redemption_mode AS prepaid_redemption_mode,
          pr.redeemed_quantity AS prepaid_quantity_used,
          e.remaining_quantity AS prepaid_quantity_remaining
        FROM prepaid_redemptions pr
        LEFT JOIN customer_prepaid_entitlements e
          ON e.id = pr.entitlement_id
         AND e.tenant_id = pr.tenant_id
        LEFT JOIN prepaid_products pp
          ON pp.id = pr.prepaid_product_id
         AND pp.tenant_id = pr.tenant_id
        WHERE pr.booking_id = b.id
        ORDER BY pr.id DESC
        LIMIT 1
      ) pr ON true
      WHERE b.tenant_id = $1
        AND b.customer_id = $2
      ORDER BY ${startTime} DESC
      LIMIT 200
      `,
      [tenantId, customerId]
    );

    return res.json({ bookings: q.rows });
  } catch (e) {
    console.error("GET /customers/me/bookings error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// NOTE:
// There is a second /me/memberships route further below that is schema-tolerant
// (it only selects columns that exist). We intentionally keep ONLY that route.

// Cancel one of my bookings (soft-cancel)
router.delete("/me/bookings/:id", requireAppAuth, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    const email = (req.googleUser?.email || "").toLowerCase();
    const bookingId = Number(req.params.id);
    if (!tenantId) return res.status(400).json({ error: "Missing tenant" });
    if (!email) return res.status(401).json({ error: "Unauthorized" });
    if (!Number.isFinite(bookingId)) return res.status(400).json({ error: "Invalid booking id" });

    const cust = await pool.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
      [tenantId, email]
    );
    if (cust.rows.length === 0) return res.status(404).json({ error: "Customer not found" });
    const customerId = cust.rows[0].id;

    const check = await pool.query(
      `SELECT id, status FROM bookings WHERE id=$1 AND tenant_id=$2 AND customer_id=$3 LIMIT 1`,
      [bookingId, tenantId, customerId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: "Booking not found" });

    // If already cancelled, idempotent success
    if ((check.rows[0].status || "").toLowerCase() === "cancelled") {
      return res.json({ ok: true, bookingId, status: "cancelled" });
    }

    await pool.query(
      `UPDATE bookings SET status='cancelled' WHERE id=$1 AND tenant_id=$2 AND customer_id=$3`,
      [bookingId, tenantId, customerId]
    );

    return res.json({ ok: true, bookingId, status: "cancelled" });
  } catch (e) {
    console.error("DELETE /customers/me/bookings/:id error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get my memberships for a tenant
};
