// routes/bookings/crud.js
// GET list, GET count, GET /:id, PATCH status, DELETE
// Mounted by routes/bookings.js

const db = require("../../db");
const { pool } = require("../../db");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const { ensureBookingMoneyColumns } = require("../../utils/ensureBookingMoneyColumns");
const { parseBookingListParams, buildBookingListWhere } = require("../../utils/bookingQueryBuilder");
const { loadJoinedBookingById, decrementSessionCount, reverseMembershipForBooking } = require("../../utils/bookings");
const {
  shouldUseCustomerHistory, checkBlackoutOverlap, servicesHasColumn, getServiceAllowMembership,
  getIdempotencyKey, mustHaveTenantSlug, canTransitionStatus, bumpTenantBookingChange,
  prepaidTablesExist, resolvePrepaidSelection, computePrepaidRedemptionSelection,
  loadMembershipCheckoutPolicy, roundUpMinutes, buildMembershipResolution,
  buildMembershipInsufficientPayload,
} = require("../../utils/bookingRouteHelpers");


module.exports = function mount(router) {
router.get("/", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const parsed = parseBookingListParams(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { where, params, orderBy, isLatest } = buildBookingListWhere(parsed, tenantId);
    const { limit } = parsed;

    const sql = `
      SELECT
        b.id,
        b.tenant_id,
        t.slug          AS tenant_slug,
        t.name          AS tenant,
        b.service_id,
        s.name          AS service_name,
        b.staff_id,
        st.name         AS staff_name,
        b.resource_id,
        r.name          AS resource_name,
        b.start_time,
        b.duration_minutes,

        -- Nightly / rental booking fields (COALESCE so old schemas without the column don't error)
        COALESCE(b.booking_mode, 'time_slots')                          AS booking_mode,
        b.checkin_date,
        b.checkout_date,
        b.nights_count,
        b.guests_count,

        -- Money + applied Rates snapshot (for booking details modals / receipts)
        b.price_amount,
        b.charge_amount,
        b.currency_code,
        b.payment_method,
        b.applied_rate_rule_id,
        b.applied_rate_snapshot,
        rr.name AS applied_rate_rule_name,

        b.customer_id,
        b.customer_membership_id,
        COALESCE(c.name, b.customer_name)   AS customer_name,
        COALESCE(c.phone, b.customer_phone) AS customer_phone,
        COALESCE(c.email, b.customer_email) AS customer_email,

        -- Membership details
        mp.name AS membership_plan_name,
        cm.minutes_remaining AS membership_minutes_remaining,
        cm.uses_remaining    AS membership_uses_remaining,
        mu.minutes_used      AS membership_minutes_used_for_booking,
        mu.uses_used         AS membership_uses_used_for_booking,

        -- Prepaid/package details
        COALESCE(pr.prepaid_applied, false) AS prepaid_applied,
        pr.prepaid_product_name,
        pr.prepaid_redemption_mode,
        pr.prepaid_quantity_used,
        pr.prepaid_quantity_remaining,

        b.status,
        b.booking_code,
        b.created_at
      FROM bookings b
      JOIN tenants t ON b.tenant_id = t.id
      LEFT JOIN customers c
        ON c.tenant_id = b.tenant_id AND c.id = b.customer_id
      LEFT JOIN services s
        ON s.tenant_id = b.tenant_id AND s.id = b.service_id
      LEFT JOIN staff st
        ON st.tenant_id = b.tenant_id AND st.id = b.staff_id
      LEFT JOIN resources r
        ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
      LEFT JOIN rate_rules rr
        ON rr.tenant_id = b.tenant_id AND rr.id = b.applied_rate_rule_id
      LEFT JOIN customer_memberships cm ON cm.id = b.customer_membership_id
      LEFT JOIN membership_plans mp ON mp.id = cm.plan_id
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
          pp.name AS prepaid_product_name,
          pr.redemption_mode AS prepaid_redemption_mode,
          pr.redeemed_quantity AS prepaid_quantity_used,
          e.remaining_quantity AS prepaid_quantity_remaining
        FROM prepaid_redemptions pr
        LEFT JOIN customer_prepaid_entitlements e ON e.id = pr.entitlement_id AND e.tenant_id = pr.tenant_id
        LEFT JOIN prepaid_products pp ON pp.id = pr.prepaid_product_id AND pp.tenant_id = pr.tenant_id
        WHERE pr.booking_id = b.id
        ORDER BY pr.id DESC LIMIT 1
      ) pr ON true
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT $${params.length + 1}
    `;

    const result = await db.query(sql, [...params, limit]);
    const rows = result.rows || [];
    const last = rows.length ? rows[rows.length - 1] : null;

    return res.json({
      bookings: rows,
      nextCursor: last
        ? (isLatest
            ? { created_at: last.created_at, id: last.id }
            : { start_time: last.start_time, id: last.id })
        : null,
    });
  } catch (err) {
    console.error("Error loading bookings:", err);
    return res.status(500).json({ error: "Failed to load bookings" });
  }
});
// ---------------------------------------------------------------------------
// GET /api/bookings/count?tenantSlug|tenantId=...
// (unchanged)
// ---------------------------------------------------------------------------
// ADMIN: bookings count (owner dashboard)
router.get("/count", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const parsed = parseBookingListParams(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { where, params } = buildBookingListWhere(parsed, tenantId);
    const needsCustomerJoin = Boolean(parsed.searchQuery);

    const sql = `
      SELECT COUNT(*)::int AS total
      FROM bookings b
      ${needsCustomerJoin ? "LEFT JOIN customers c ON c.tenant_id = b.tenant_id AND c.id = b.customer_id" : ""}
      WHERE ${where.join(" AND ")}
    `;

    const result = await db.query(sql, params);
    return res.json({ total: result.rows?.[0]?.total ?? 0 });
  } catch (err) {
    console.error("Error counting bookings:", err);
    return res.status(500).json({ error: "Failed to count bookings" });
  }
});
// ---------------------------------------------------------------------------
// GET /api/bookings/:id?tenantSlug|tenantId=
// Tenant-scoped read (used by dashboards / detail views)
// IMPORTANT: Do NOT bump heartbeat on reads.
// ---------------------------------------------------------------------------
// ADMIN: booking detail (owner dashboard)
router.get("/:id", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    const result = await db.query(
      `SELECT id FROM bookings WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL LIMIT 1`, // PR-19
      [bookingId, tenantId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const joined = await loadJoinedBookingById(bookingId, tenantId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error loading booking:", err);
    return res.status(500).json({ error: "Failed to load booking" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/bookings/:id/status?tenantSlug|tenantId=
// ---------------------------------------------------------------------------
// ADMIN: change booking status
router.patch("/:id/status", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    if (!mustHaveTenantSlug(req, res)) return;

    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);
    const { status } = req.body || {};

    const allowed = new Set(["pending", "confirmed", "cancelled"]);
    const nextStatus = String(status || "").toLowerCase();
    if (!allowed.has(nextStatus)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    const curRes = await db.query(
      `SELECT status FROM bookings WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL LIMIT 1`, // PR-19
      [bookingId, tenantId]
    );
    if (!curRes.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const currentStatus = String(curRes.rows[0].status || "").toLowerCase();
    if (!canTransitionStatus(currentStatus, nextStatus)) {
      return res.status(409).json({
        error: `Invalid status transition: ${currentStatus} → ${nextStatus}`,
      });
    }

    if (currentStatus === nextStatus) {
      const joined = await loadJoinedBookingById(bookingId, tenantId);
      return res.json({ booking: joined });
    }

    // Wrap in a transaction so the status update and any membership reversal
    // are atomic — either both commit or both roll back.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const upd = await client.query(
        `UPDATE bookings
         SET status=$1
         WHERE id=$2 AND tenant_id=$3
         RETURNING id`,
        [nextStatus, bookingId, tenantId]
      );

      if (!upd.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Booking not found." });
      }

      // If the booking is being cancelled, return any membership credits
      // that were consumed when the booking was originally created.
      if (nextStatus === "cancelled") {
        await reverseMembershipForBooking(client, bookingId, tenantId);
      }

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    await bumpTenantBookingChange(tenantId);

    const joined = await loadJoinedBookingById(bookingId, tenantId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error updating booking status:", err);
    return res.status(500).json({ error: "Failed to update booking status." });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/bookings/:id?tenantSlug|tenantId=
// ---------------------------------------------------------------------------
// ADMIN: cancel booking (DELETE used as cancel)
router.delete("/:id", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    if (!mustHaveTenantSlug(req, res)) return;

    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    const curRes = await db.query(
      `SELECT status, session_id FROM bookings WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL LIMIT 1`, // PR-19
      [bookingId, tenantId]
    );
    if (!curRes.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const currentStatus = String(curRes.rows[0].status || "").toLowerCase();
    const bookingSessionId = curRes.rows[0].session_id || null;
    const nextStatus = "cancelled";

    if (!canTransitionStatus(currentStatus, nextStatus)) {
      return res.status(409).json({
        error: `Invalid status transition: ${currentStatus} → ${nextStatus}`,
      });
    }

    if (currentStatus !== nextStatus) {
      // Wrap in a transaction so the status update, membership reversal, and
      // session decrement are all atomic.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `UPDATE bookings
           SET status='cancelled'
           WHERE id=$1 AND tenant_id=$2`,
          [bookingId, tenantId]
        );

        // Return any membership credits consumed when this booking was created.
        await reverseMembershipForBooking(client, bookingId, tenantId);

        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }

      // If this was a parallel booking, decrement the session confirmed_count.
      // Done outside the transaction because decrementSessionCount uses pool directly.
      if (bookingSessionId) {
        await decrementSessionCount({ sessionId: bookingSessionId });
      }
    }

    await bumpTenantBookingChange(tenantId);

    const joined = await loadJoinedBookingById(bookingId, tenantId);
    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error cancelling booking:", err);
    return res.status(500).json({ error: "Failed to cancel booking." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bookings
// Public booking creation (tenantSlug required)
// ---------------------------------------------------------------------------
// Phase C: booking creation is authenticated (prevents ghost bookings after session expiry).
};
