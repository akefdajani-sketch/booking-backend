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
const resolveStaffScope = require("../../middleware/resolveStaffScope");
const { loadJoinedBookingById, decrementSessionCount, reverseMembershipForBooking } = require("../../utils/bookings");
const {
  shouldUseCustomerHistory, checkBlackoutOverlap, servicesHasColumn, getServiceAllowMembership,
  getIdempotencyKey, mustHaveTenantSlug, canTransitionStatus, bumpTenantBookingChange,
  prepaidTablesExist, resolvePrepaidSelection, computePrepaidRedemptionSelection,
  loadMembershipCheckoutPolicy, roundUpMinutes, buildMembershipResolution,
  buildMembershipInsufficientPayload,
} = require("../../utils/bookingRouteHelpers");


module.exports = function mount(router) {
router.get("/", requireTenant, requireAdminOrTenantRole("staff"), resolveStaffScope, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const parsed = parseBookingListParams(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { where, params, orderBy, isLatest } = buildBookingListWhere(parsed, tenantId);

    // Staff scope: only show bookings for this staff member
    if (req.isStaffScoped) {
      if (req.staffId) {
        where.push(`b.staff_id = $${params.length + 1}`);
        params.push(req.staffId);
      } else {
        // Staff role but no linked staff record — return empty
        return res.json({ bookings: [], cursor: null, has_more: false });
      }
    }
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
        b.created_at,

        -- PR-TAX-1: tax breakdown snapshot (NULL on pre-migration DBs)
        b.subtotal_amount,
        b.vat_amount,
        b.service_charge_amount,
        b.total_amount,
        b.tax_snapshot
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
// PR 134 — staff scoping: staff-role users with linked staff_id only count
// their own bookings. Staff-role users without a linked staff record get 0.
router.get("/count", requireTenant, requireAdminOrTenantRole("staff"), resolveStaffScope, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const parsed = parseBookingListParams(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { where, params } = buildBookingListWhere(parsed, tenantId);
    const needsCustomerJoin = Boolean(parsed.searchQuery);

    // PR 134 — apply staff scope
    if (req.isStaffScoped) {
      if (req.staffId) {
        where.push(`b.staff_id = $${params.length + 1}`);
        params.push(req.staffId);
      } else {
        // Staff role but no linked staff record — return zero count
        return res.json({ total: 0 });
      }
    }

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
// PR 134 — staff scoping: staff-role users with linked staff_id can only
// fetch bookings where b.staff_id matches theirs. Returns 404 (not 403)
// for scoped users requesting other staff's bookings, to avoid leaking
// the existence of those records.
router.get("/:id", requireTenant, requireAdminOrTenantRole("staff"), resolveStaffScope, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    // PR 134 — staff-scoped existence check: include staff_id in the WHERE
    // when the user is scoped, so cross-staff probes 404 cleanly.
    let existsSql = `SELECT id FROM bookings WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`;
    const existsParams = [bookingId, tenantId];
    if (req.isStaffScoped) {
      if (!req.staffId) {
        return res.status(404).json({ error: "Booking not found." });
      }
      existsSql += ` AND staff_id = $3`;
      existsParams.push(req.staffId);
    }
    existsSql += ` LIMIT 1`;

    const result = await db.query(existsSql, existsParams); // PR-19
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
// PR 134 — staff scoping: staff-role users with linked staff_id can only
// update bookings where b.staff_id matches theirs. Cross-staff updates 404.
router.patch("/:id/status", requireTenant, requireAdminOrTenantRole("staff"), resolveStaffScope, async (req, res) => {
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

    // PR 134 — scoped existence + status lookup
    let curSql = `SELECT status FROM bookings WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`;
    const curParams = [bookingId, tenantId];
    if (req.isStaffScoped) {
      if (!req.staffId) {
        return res.status(404).json({ error: "Booking not found." });
      }
      curSql += ` AND staff_id = $3`;
      curParams.push(req.staffId);
    }
    curSql += ` LIMIT 1`;

    const curRes = await db.query(curSql, curParams); // PR-19
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

    // ── H3.5: Twilio SMS cancellation (non-fatal, fires after response) ──
    // Only send if the transition actually happened (not a no-op re-cancel).
    if (currentStatus !== nextStatus && joined?.customer_phone) {
      setImmediate(async () => {
        try {
          // D5: 3-gate check (plan + creds + per-event toggle).
          const { shouldSendSMS } = require('../../utils/notificationGates');
          const gate = await shouldSendSMS(tenantId, 'cancellations');
          if (!gate.ok) return;

          const { sendBookingCancellation } = require('../../utils/twilioSms');

          const tRes = await pool.query(
            'SELECT name, timezone FROM tenants WHERE id = $1',
            [tenantId]
          );
          const tenantName     = tRes.rows?.[0]?.name     || 'Flexrz';
          const tenantTimezone = tRes.rows?.[0]?.timezone || 'Asia/Amman';

          const smsResult = await sendBookingCancellation({
            booking: joined,
            tenantName,
            tenantTimezone,
            tenantId,
          });

          if (smsResult.ok) {
            require('../../utils/logger').info(
              { bookingId, msgSid: smsResult.messageSid },
              'SMS cancellation sent'
            );
          } else {
            require('../../utils/logger').warn(
              { bookingId, reason: smsResult.reason },
              'SMS cancellation skipped'
            );
          }
        } catch (smsErr) {
          require('../../utils/logger').error(
            { err: smsErr.message, bookingId },
            'SMS cancellation error (non-fatal)'
          );
        }
      });
    }
    // ── End SMS cancellation ──────────────────────────────────────────────

    // ── H: Customer email cancellation (non-fatal, fires after response) ──
    // Mirrors SMS path but for customer.email.
    if (currentStatus !== nextStatus && joined?.customer_email) {
      setImmediate(async () => {
        try {
          const { shouldSendEmail } = require('../../utils/notificationGates');
          const gate = await shouldSendEmail(tenantId, 'cancellations');
          if (!gate.ok) return;

          const { sendEmail } = require('../../utils/email');
          const { renderBookingCancellation } = require('../../utils/customerBookingEmailTemplates');

          const tRes = await pool.query(
            `SELECT name, slug, logo_url, branding->>'timezone' AS timezone, branding->>'primary_color' AS primary_color
               FROM tenants WHERE id = $1`,
            [tenantId]
          );
          const tRow = tRes.rows?.[0] || {};
          const APP_BASE = (process.env.APP_BASE_URL || 'https://app.flexrz.com').replace(/\/+$/, '');

          const tpl = renderBookingCancellation({
            tenantName:     tRow.name || 'Flexrz',
            tenantLogoUrl:  tRow.logo_url || null, // J.3: brand the email
            tenantTimezone: tRow.timezone || 'Asia/Amman',
            bookingUrl:     tRow.slug ? `${APP_BASE}/book/${encodeURIComponent(tRow.slug)}` : null,
            customerName:   joined.customer_name,
            serviceName:    joined.service_name,
            resourceName:   joined.resource_name,
            startTime:      joined.start_time,
            bookingCode:    joined.booking_code,
            accentColor:    tRow.primary_color,
          });

          const emailResult = await sendEmail({
            kind: 'booking_cancellation',
            to: joined.customer_email,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
            tenantId,
            meta: { booking_id: bookingId },
          });

          if (emailResult.status === 'sent') {
            require('../../utils/logger').info(
              { bookingId, recipient: joined.customer_email },
              'Email cancellation sent'
            );
          } else {
            require('../../utils/logger').info(
              { bookingId, status: emailResult.status, error: emailResult.error },
              'Email cancellation not sent'
            );
          }
        } catch (emailErr) {
          require('../../utils/logger').error(
            { err: emailErr.message, bookingId },
            'Email cancellation error (non-fatal)'
          );
        }
      });
    }
    // ── End email cancellation ────────────────────────────────────────────

    return res.json({ booking: joined });
  } catch (err) {
    console.error("Error cancelling booking:", err);
    return res.status(500).json({ error: "Failed to cancel booking." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/bookings/stats?tenantSlug=&days=30
// ADMIN: rich analytics snapshot for the owner dashboard.
//
// Returns:
//   revenue_total        — sum of charge_amount for confirmed bookings in window
//   revenue_by_day       — [{date: "YYYY-MM-DD", amount: number}] last N days
//   bookings_by_day      — [{date: "YYYY-MM-DD", count: number}] last N days
//   bookings_by_service  — [{service_name, count}] top 8
//   cancelled_count      — cancelled bookings in window
//   confirmed_count      — confirmed bookings in window
//   pending_count        — pending bookings in window
//   cancellation_rate    — 0-100 percentage
// ---------------------------------------------------------------------------
router.get("/stats", requireTenant, requireAdminOrTenantRole("staff"), resolveStaffScope, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const daysRaw = req.query.days ? Number(req.query.days) : 30;
    const days = Math.max(1, Math.min(365, Number.isFinite(daysRaw) ? daysRaw : 30));

    // Window: last N days up to end of today
    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setDate(windowStart.getDate() - days);
    windowStart.setHours(0, 0, 0, 0);

    const params = [tenantId, windowStart.toISOString()];

    // PR 134 — staff scope. When active, append staff_id filter to every
    // query and short-circuit with zeros when the staff-role user has no
    // linked staff record (so the dashboard shows empty state, not errors).
    if (req.isStaffScoped && !req.staffId) {
      return res.json({
        window_days:        days,
        confirmed_count:    0,
        cancelled_count:    0,
        pending_count:      0,
        revenue_total:      0,
        cancellation_rate:  0,
        bookings_by_day:    [],
        revenue_by_day:     [],
        bookings_by_service: [],
        // PR M
        revenue_by_service: [],
        bookings_by_hour:   [],
        bookings_by_dow:    [],
        avg_booking_value:  0,
        repeat_customer:    { rate: 0, repeat_count: 0, total: 0 },
      });
    }
    // Use a helper fragment + param append so each query shares the same scope
    let staffFilter = "";
    if (req.isStaffScoped && req.staffId) {
      params.push(req.staffId);
      staffFilter = ` AND staff_id = $${params.length}`;
    }

    // --- Status counts + revenue in window ---
    const summaryRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'confirmed')::int  AS confirmed_count,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int  AS cancelled_count,
         COUNT(*) FILTER (WHERE status = 'pending')::int    AS pending_count,
         COALESCE(SUM(charge_amount) FILTER (WHERE status = 'confirmed'), 0)::numeric AS revenue_total
       FROM bookings
       WHERE tenant_id = $1
         AND start_time >= $2
         AND deleted_at IS NULL${staffFilter}`,
      params
    );

    const summary = summaryRes.rows[0] || {};
    const confirmedCount = Number(summary.confirmed_count || 0);
    const cancelledCount = Number(summary.cancelled_count || 0);
    const pendingCount   = Number(summary.pending_count   || 0);
    const revenueTotal   = parseFloat(summary.revenue_total || 0);
    const totalBookings  = confirmedCount + cancelledCount + pendingCount;
    const cancellationRate = totalBookings > 0
      ? Math.round((cancelledCount / totalBookings) * 100)
      : 0;

    // --- Bookings by day (last N days) ---
    const byDayRes = await db.query(
      `SELECT
         TO_CHAR(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
         COUNT(*)::int AS count
       FROM bookings
       WHERE tenant_id = $1
         AND start_time >= $2
         AND deleted_at IS NULL${staffFilter}
       GROUP BY date
       ORDER BY date ASC`,
      params
    );

    // --- Revenue by day (confirmed only) ---
    const revByDayRes = await db.query(
      `SELECT
         TO_CHAR(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
         COALESCE(SUM(charge_amount), 0)::numeric AS amount
       FROM bookings
       WHERE tenant_id = $1
         AND start_time >= $2
         AND status = 'confirmed'
         AND deleted_at IS NULL${staffFilter}
       GROUP BY date
       ORDER BY date ASC`,
      params
    );

    // --- Top services ---
    const byServiceRes = await db.query(
      `SELECT
         COALESCE(s.name, 'Unknown') AS service_name,
         COUNT(b.id)::int AS count
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       WHERE b.tenant_id = $1
         AND b.start_time >= $2
         AND b.deleted_at IS NULL${staffFilter ? staffFilter.replace(/staff_id/g, "b.staff_id") : ""}
       GROUP BY COALESCE(s.name, 'Unknown')
       ORDER BY count DESC
       LIMIT 8`,
      params
    );

    // PR 122 (v2 §3.1 + companion to frontend Patch 106 B1.2):
    // ----------------------------------------------------------------
    // Staff & resource breakdown for the utilization widget.
    // staffSupported = tenant has at least one staff row AND at least
    //                  one booking references staff_id in the window.
    // resourceSupported = same question for resources.
    // When false, the frontend can hide the corresponding section of
    // the utilization card without computing anything — matches the
    // "only show staff who actually deliver services" rule from §3.1.
    //
    // Note: the staff/resource count queries don't apply staffFilter —
    // staffSupported/resourceSupported are about the TENANT's shape,
    // not the scoped user's view. The topStaff / topResources queries
    // DO apply staffFilter (via b.staff_id) to keep list consistency
    // with scoped users.
    const staffCountRes = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM staff WHERE tenant_id = $1) AS staff_total,
         COUNT(DISTINCT b.staff_id) FILTER (WHERE b.staff_id IS NOT NULL)::int AS staff_with_bookings
       FROM bookings b
       WHERE b.tenant_id = $1
         AND b.start_time >= $2
         AND b.deleted_at IS NULL`,
      params
    );
    const staffTotal = Number(staffCountRes.rows[0]?.staff_total || 0);
    const staffWithBookings = Number(staffCountRes.rows[0]?.staff_with_bookings || 0);
    const staffSupported = staffTotal > 0 && staffWithBookings > 0;

    const resourceCountRes = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM resources WHERE tenant_id = $1) AS resource_total,
         COUNT(DISTINCT b.resource_id) FILTER (WHERE b.resource_id IS NOT NULL)::int AS resources_with_bookings
       FROM bookings b
       WHERE b.tenant_id = $1
         AND b.start_time >= $2
         AND b.deleted_at IS NULL`,
      params
    );
    const resourceTotal = Number(resourceCountRes.rows[0]?.resource_total || 0);
    const resourcesWithBookings = Number(resourceCountRes.rows[0]?.resources_with_bookings || 0);
    const resourceSupported = resourceTotal > 0 && resourcesWithBookings > 0;

    // Top staff — only if supported
    let topStaff = [];
    if (staffSupported) {
      const staffRes = await db.query(
        `SELECT
           COALESCE(st.name, 'Unknown') AS staff_name,
           COUNT(b.id)::int AS count
         FROM bookings b
         LEFT JOIN staff st ON st.id = b.staff_id
         WHERE b.tenant_id = $1
           AND b.start_time >= $2
           AND b.deleted_at IS NULL
           AND b.staff_id IS NOT NULL${staffFilter ? staffFilter.replace(/staff_id/g, "b.staff_id") : ""}
         GROUP BY COALESCE(st.name, 'Unknown')
         ORDER BY count DESC
         LIMIT 5`,
        params
      );
      topStaff = staffRes.rows;
    }

    // Top resources — only if supported
    let topResources = [];
    if (resourceSupported) {
      const resRes = await db.query(
        `SELECT
           COALESCE(r.name, 'Unknown') AS resource_name,
           COUNT(b.id)::int AS count
         FROM bookings b
         LEFT JOIN resources r ON r.id = b.resource_id
         WHERE b.tenant_id = $1
           AND b.start_time >= $2
           AND b.deleted_at IS NULL
           AND b.resource_id IS NOT NULL${staffFilter ? staffFilter.replace(/staff_id/g, "b.staff_id") : ""}
         GROUP BY COALESCE(r.name, 'Unknown')
         ORDER BY count DESC
         LIMIT 5`,
        params
      );
      topResources = resRes.rows;
    }

    // ── PR M (Metrics expansion) ─────────────────────────────────────────────
    // 5 new analytics datasets, all over the same window/scope as the existing
    // queries. Each is a single SQL aggregate — total cost ~30-50ms across all
    // 5 on a typical prod DB.

    // 1. Revenue by service — top 10. Distinct from bookings_by_service which
    //    is COUNT-based; this is SUM-based. Different question:
    //    "which services make money?" vs "which are most popular?"
    const revenueByServiceRes = await db.query(
      `SELECT
         COALESCE(s.name, 'Unknown') AS service_name,
         COALESCE(SUM(b.charge_amount) FILTER (WHERE b.status = 'confirmed'), 0)::numeric AS revenue
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       WHERE b.tenant_id = $1
         AND b.start_time >= $2
         AND b.deleted_at IS NULL${staffFilter}
       GROUP BY COALESCE(s.name, 'Unknown')
       HAVING COALESCE(SUM(b.charge_amount) FILTER (WHERE b.status = 'confirmed'), 0) > 0
       ORDER BY revenue DESC
       LIMIT 10`,
      params
    );

    // 2. Bookings by hour-of-day — 24 buckets. Confirmed bookings only (we
    //    care about what actually ran). Returned as { hour: 0-23, count: N }
    //    sparse array — frontend zero-fills.
    const byHourRes = await db.query(
      `SELECT
         EXTRACT(HOUR FROM start_time)::int AS hour,
         COUNT(*)::int AS count
       FROM bookings
       WHERE tenant_id = $1
         AND start_time >= $2
         AND status = 'confirmed'
         AND deleted_at IS NULL${staffFilter}
       GROUP BY EXTRACT(HOUR FROM start_time)
       ORDER BY hour`,
      params
    );

    // 3. Bookings by day-of-week — 7 buckets, Postgres DOW: 0=Sunday, 6=Saturday.
    //    Same scoping as bookings_by_hour.
    const byDowRes = await db.query(
      `SELECT
         EXTRACT(DOW FROM start_time)::int AS dow,
         COUNT(*)::int AS count
       FROM bookings
       WHERE tenant_id = $1
         AND start_time >= $2
         AND status = 'confirmed'
         AND deleted_at IS NULL${staffFilter}
       GROUP BY EXTRACT(DOW FROM start_time)
       ORDER BY dow`,
      params
    );

    // 4. Average booking value — revenue_total / confirmed_count. Pre-computed
    //    server-side so the frontend doesn't accidentally divide by zero.
    const avgBookingValue = confirmedCount > 0 ? (revenueTotal / confirmedCount) : 0;

    // 5. Repeat customer rate — % of confirmed bookings whose customer had
    //    an EARLIER confirmed booking with this tenant. Trickier: needs to
    //    look at ALL prior bookings (not just within the window) to detect
    //    "this customer has booked before". Using a window function so we
    //    only scan once.
    //
    //    Definition:
    //      total      = confirmed bookings in window (with customer_id)
    //      repeat     = subset where the customer had a confirmed booking
    //                   anywhere in this tenant strictly before this booking
    //      rate       = repeat / total * 100
    const repeatRes = await db.query(
      `WITH ranked AS (
         SELECT
           b.customer_id,
           b.start_time,
           ROW_NUMBER() OVER (PARTITION BY b.customer_id ORDER BY b.start_time) AS n,
           (b.start_time >= $2)::boolean AS in_window
         FROM bookings b
         WHERE b.tenant_id = $1
           AND b.status = 'confirmed'
           AND b.customer_id IS NOT NULL
           AND b.deleted_at IS NULL${staffFilter}
       )
       SELECT
         COUNT(*) FILTER (WHERE in_window)::int AS total,
         COUNT(*) FILTER (WHERE in_window AND n > 1)::int AS repeat_count
       FROM ranked`,
      params
    );
    const repeatTotal = Number(repeatRes.rows[0]?.total || 0);
    const repeatCount = Number(repeatRes.rows[0]?.repeat_count || 0);
    const repeatRate  = repeatTotal > 0 ? Math.round((repeatCount / repeatTotal) * 1000) / 10 : 0;

    return res.json({
      window_days:        days,
      confirmed_count:    confirmedCount,
      cancelled_count:    cancelledCount,
      pending_count:      pendingCount,
      revenue_total:      revenueTotal,
      cancellation_rate:  cancellationRate,
      bookings_by_day:    byDayRes.rows,
      revenue_by_day:     revByDayRes.rows.map((r) => ({ date: r.date, amount: parseFloat(r.amount) })),
      bookings_by_service: byServiceRes.rows,
      // PR 122: utilization breakdown — consumed by frontend Patch 106
      breakdown: {
        staffSupported,
        resourceSupported,
        topStaff,
        topResources,
      },
      // PR M (Metrics expansion): deeper analytics datasets
      revenue_by_service: revenueByServiceRes.rows.map((r) => ({
        service_name: r.service_name,
        revenue: parseFloat(r.revenue),
      })),
      bookings_by_hour: byHourRes.rows,           // [{ hour: 0-23, count }]
      bookings_by_dow:  byDowRes.rows,            // [{ dow: 0-6,  count }] (0=Sun)
      avg_booking_value: avgBookingValue,         // number (matches revenue_total currency)
      repeat_customer:  {
        rate: repeatRate,                         // 0-100, one-decimal
        repeat_count: repeatCount,
        total: repeatTotal,
      },
    });
  } catch (err) {
    console.error("Error loading booking stats:", err);
    return res.status(500).json({ error: "Failed to load booking stats." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bookings
// Public booking creation (tenantSlug required)
// ---------------------------------------------------------------------------
// Phase C: booking creation is authenticated (prevents ghost bookings after session expiry).
};
