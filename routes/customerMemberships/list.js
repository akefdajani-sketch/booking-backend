// routes/customerMemberships/list.js
// Customer self-service GET, admin GET /, admin GET /ledger
// Mounted by routes/customerMemberships.js

const { pool } = require("../../db");
const db = pool;
const requireAdminOrTenantRole = require("../../middleware/requireAdminOrTenantRole");
const requireAppAuth = require("../../middleware/requireAppAuth");
const { requireTenant } = require("../../middleware/requireTenant");
const { getExistingColumns, firstExisting, pickCol, safeIntExpr } = require("../../utils/customerQueryHelpers");


function isValidAdminKey(req) {
  const rawAuth = String(req.headers.authorization || "");
  const bearer = rawAuth.toLowerCase().startsWith("bearer ")
    ? rawAuth.slice(7).trim()
    : null;
  const key =
    bearer ||
    String(req.headers["x-admin-key"] || "").trim() ||
    String(req.headers["x-api-key"] || "").trim();
  const expected = String(process.env.ADMIN_API_KEY || "").trim();
  if (!expected || !key) return false;
  return key === expected;
}

function shouldUseCustomerView(req) {
  if (isValidAdminKey(req)) return false;

  const hasAdminFilters = [
    req.query.customerId,
    req.query.q,
    req.query.status,
    req.query.limit,
    req.query.offset,
    req.query.includeExpired,
    req.query.includeArchived,
  ].some((value) => value !== undefined && value !== null && String(value).trim() !== "");

  if (hasAdminFilters) return false;

  return true;
}

module.exports = function mount(router) {
router.get(
  "/",
  (req, res, next) => {
    if (shouldUseCustomerView(req)) return next();
    return next("route");
  },
  requireAppAuth,
  requireTenant,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const googleEmail = String(req.auth?.email || req.googleUser?.email || "").toLowerCase();
      const customerEmail = String(req.query.customerEmail || "").toLowerCase();

      // If the caller provided customerEmail, ensure it matches the signed-in user
      if (customerEmail && googleEmail && customerEmail !== googleEmail) {
        return res.status(403).json({ error: "Forbidden" });
      }

      let customerId = Number(req.query.customerId);

      // Resolve customerId by email if needed
      if ((!Number.isFinite(customerId) || customerId <= 0) && googleEmail) {
        const c = await db.query(
          `SELECT id FROM customers WHERE tenant_id=$1 AND lower(email)=lower($2) LIMIT 1`,
          [tenantId, googleEmail]
        );
        customerId = c.rows?.[0]?.id ? Number(c.rows[0].id) : NaN;
      }

      // Validate the customer belongs to this tenant and matches the signed-in email
      if (Number.isFinite(customerId) && customerId > 0) {
        const c2 = await db.query(
          `SELECT id, email FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
          [customerId, tenantId]
        );
        if (!c2.rows[0]) return res.json({ memberships: [] });
        const dbEmail = String(c2.rows[0].email || "").toLowerCase();
        if (googleEmail && dbEmail && dbEmail !== googleEmail) {
          return res.status(403).json({ error: "Forbidden" });
        }
      } else {
        return res.json({ memberships: [] });
      }

      // Same filters as admin endpoint
      const includeExpired = String(req.query.includeExpired || "").toLowerCase() === "true";
      const includeArchived = String(req.query.includeArchived || "").toLowerCase() === "true";

      const where = ["cm.tenant_id=$1", "cm.customer_id=$2"];
      const params = [tenantId, customerId];

      if (!includeExpired) where.push("(cm.end_at IS NULL OR cm.end_at > NOW())");
      if (!includeArchived) where.push("cm.status <> 'archived'");

      const q = `
        SELECT
          cm.id,
          cm.customer_id,
          cm.plan_id AS membership_plan_id,
          cm.status,
          cm.start_at,
          cm.end_at,
          NULL AS minutes_total,
          NULL AS minutes_used,
          cm.created_at,
          mp.name AS plan_name,
          mp.price AS plan_price,
          mp.valid_days AS plan_valid_days
        FROM customer_memberships cm
        LEFT JOIN membership_plans mp ON mp.id = cm.plan_id
        WHERE ${where.join(" AND ")}
        ORDER BY cm.created_at DESC
        LIMIT 100
      `;

      const r = await db.query(q, params);
      return res.json({ memberships: r.rows || [] });
    } catch (e) {
      console.error("customer-memberships(customer) error", e);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

router.get("/", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const rawCustomerId = Number(req.query.customerId);
    const customerId = Number.isFinite(rawCustomerId) && rawCustomerId > 0 ? rawCustomerId : null;
    const includeExpired = String(req.query.includeExpired || "").toLowerCase() === "true";
    const includeArchived = String(req.query.includeArchived || "").toLowerCase() === "true";
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

    if (customerId) {
      const c = await db.query(
        `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [customerId, tenantId]
      );
      if (!c.rows.length) {
        return res.json({ memberships: [], meta: { total: 0, limit, offset, hasMore: false } });
      }
    }

    // Build a schema-compatible query. Some environments still have the legacy
    // membership schema (credits_remaining / starts_at / expires_at / duration_days),
    // while newer environments use minutes_remaining / uses_remaining / start_at / end_at.
    const cmPlanId = await pickCol("customer_memberships", "cm", ["plan_id", "membership_plan_id"]);
    const cmStatusRaw = await pickCol("customer_memberships", "cm", ["status"], "'active'");
    const cmStarted = await pickCol(
      "customer_memberships",
      "cm",
      ["started_at", "starts_at", "start_at", "created_at"],
      "NULL"
    );
    const cmEndAt = await pickCol(
      "customer_memberships",
      "cm",
      ["end_at", "expires_at", "valid_until"],
      "NULL"
    );
    const cmMinutesRemaining = await pickCol("customer_memberships", "cm", ["minutes_remaining"], "NULL");
    const cmUsesRemaining = await pickCol("customer_memberships", "cm", ["uses_remaining"], "NULL");
    const cmCreditsRemaining = await pickCol("customer_memberships", "cm", ["credits_remaining"], "NULL");
    const orderCol = await pickCol(
      "customer_memberships",
      "cm",
      ["created_at", "started_at", "starts_at", "start_at"],
      "cm.id"
    );

    const mpName = await pickCol("membership_plans", "mp", ["name", "title"], "NULL");
    const mpDesc = await pickCol("membership_plans", "mp", ["description", "subtitle"], "NULL");
    const mpPrice = await pickCol("membership_plans", "mp", ["price"], "NULL");
    const mpCurrency = await pickCol("membership_plans", "mp", ["currency", "currency_code"], "'USD'");
    const mpIncludedMinutes = await pickCol(
      "membership_plans",
      "mp",
      ["included_minutes", "minutes_total", "minutes_included"],
      "NULL"
    );
    const mpIncludedUses = await pickCol(
      "membership_plans",
      "mp",
      ["included_uses", "uses_total", "uses_included"],
      "NULL"
    );
    const mpValidityDays = await pickCol("membership_plans", "mp", ["validity_days", "duration_days"], "NULL");

    // Legacy shape only has credits_remaining, so treat that as minutes_remaining
    // for list-display purposes. This keeps the owner page stable until all tenants
    // are migrated to the ledger-era membership schema.
    const minutesRemainingExpr = `COALESCE(${cmMinutesRemaining}, ${cmCreditsRemaining}, 0)`;
    const usesRemainingExpr = `COALESCE(${cmUsesRemaining}, 0)`;

    const lifecycleCase = `
      CASE
        WHEN LOWER(COALESCE(${cmStatusRaw}::text, 'active')) = 'archived' THEN 'archived'
        WHEN ${cmEndAt} IS NOT NULL AND ${cmEndAt} <= NOW() THEN 'expired'
        WHEN ${cmStarted} IS NOT NULL AND ${cmStarted} > NOW() THEN 'scheduled'
        WHEN LOWER(COALESCE(${cmStatusRaw}::text, 'active')) = 'active' THEN 'active'
        ELSE LOWER(COALESCE(${cmStatusRaw}::text, 'active'))
      END
    `;

    const params = [tenantId];
    let where = `WHERE cm.tenant_id = $1`;

    if (customerId) {
      params.push(customerId);
      where += ` AND cm.customer_id = $${params.length}`;
    }

    if (!includeExpired) {
      where += ` AND (${cmEndAt} IS NULL OR ${cmEndAt} > NOW())`;
    }
    if (!includeArchived) {
      where += ` AND LOWER(COALESCE(${cmStatusRaw}::text, 'active')) <> 'archived'`;
    }
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR c.email ILIKE $${params.length} OR ${mpName} ILIKE $${params.length})`;
    }
    if (status && status !== "all") {
      params.push(status);
      where += ` AND (${lifecycleCase}) = $${params.length}`;
    }

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM customer_memberships cm
      LEFT JOIN membership_plans mp
        ON mp.id = ${cmPlanId}
       AND mp.tenant_id = $1
      JOIN customers c
        ON c.id = cm.customer_id
       AND c.tenant_id = cm.tenant_id
      ${where}
    `;
    const countResult = await db.query(countSql, params);
    const total = Number(countResult.rows?.[0]?.total || 0);

    const dataParams = [...params, limit, offset];
    const limitParam = `$${dataParams.length - 1}`;
    const offsetParam = `$${dataParams.length}`;

    const dataSql = `
      SELECT
        cm.id,
        cm.tenant_id,
        cm.customer_id,
        ${cmPlanId} AS plan_id,
        LOWER(COALESCE(${cmStatusRaw}::text, 'active')) AS status,
        ${cmStarted} AS start_at,
        ${cmEndAt} AS end_at,
        ${safeIntExpr(minutesRemainingExpr)} AS minutes_remaining,
        ${safeIntExpr(usesRemainingExpr)} AS uses_remaining,
        cm.created_at,
        cm.updated_at,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,
        ${mpName} AS plan_name,
        ${mpDesc} AS plan_description,
        ${mpPrice} AS plan_price,
        ${mpCurrency} AS plan_currency,
        ${safeIntExpr(mpIncludedMinutes)} AS included_minutes,
        ${safeIntExpr(mpIncludedUses)} AS included_uses,
        ${safeIntExpr(mpValidityDays)} AS validity_days,
        ${lifecycleCase} AS lifecycle_state,
        (
          LOWER(COALESCE(${cmStatusRaw}::text, 'active')) = 'active'
          AND (${cmStarted} IS NULL OR ${cmStarted} <= NOW())
          AND (${cmEndAt} IS NULL OR ${cmEndAt} > NOW())
        ) AS is_currently_active
      FROM customer_memberships cm
      LEFT JOIN membership_plans mp
        ON mp.id = ${cmPlanId}
       AND mp.tenant_id = $1
      JOIN customers c
        ON c.id = cm.customer_id
       AND c.tenant_id = cm.tenant_id
      ${where}
      ORDER BY
        CASE
          WHEN ${lifecycleCase} = 'active' THEN 0
          WHEN ${lifecycleCase} = 'scheduled' THEN 1
          WHEN ${lifecycleCase} = 'expired' THEN 2
          WHEN ${lifecycleCase} = 'archived' THEN 3
          ELSE 4
        END ASC,
        ${orderCol} DESC NULLS LAST,
        cm.id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;
    const r = await db.query(dataSql, dataParams);

    return res.json({
      memberships: r.rows,
      meta: {
        total,
        limit,
        offset,
        hasMore: offset + r.rows.length < total,
      },
    });
  } catch (err) {
    console.error("GET /api/customer-memberships error:", err);
    return res.status(500).json({ error: "Failed to load memberships." });
  }
});


// GET /api/customer-memberships/ledger?tenantSlug=...?tenantSlug=...

router.get("/ledger", requireTenant, requireAdminOrTenantRole("staff"), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const q = String(req.query.q || "").trim();
    const customerIdRaw = Number(req.query.customerId);
    const membershipIdRaw = Number(req.query.membershipId);
    const bookingIdRaw = Number(req.query.bookingId);
    const type = String(req.query.type || "all").trim().toLowerCase();
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

    const customerId = Number.isFinite(customerIdRaw) && customerIdRaw > 0 ? customerIdRaw : null;
    const membershipId = Number.isFinite(membershipIdRaw) && membershipIdRaw > 0 ? membershipIdRaw : null;
    const bookingId = Number.isFinite(bookingIdRaw) && bookingIdRaw > 0 ? bookingIdRaw : null;

    const params = [tenantId];
    const where = ["ml.tenant_id = $1"];

    if (customerId) {
      params.push(customerId);
      where.push(`cm.customer_id = $${params.length}`);
    }
    if (membershipId) {
      params.push(membershipId);
      where.push(`ml.customer_membership_id = $${params.length}`);
    }
    if (bookingId) {
      params.push(bookingId);
      where.push(`ml.booking_id = $${params.length}`);
    }
    if (type && type !== "all") {
      params.push(type);
      where.push(`LOWER(COALESCE(ml.type, '')) = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(
        c.name ILIKE $${params.length}
        OR c.email ILIKE $${params.length}
        OR c.phone ILIKE $${params.length}
        OR mp.name ILIKE $${params.length}
        OR COALESCE(ml.note, '') ILIKE $${params.length}
        OR COALESCE(s.name, '') ILIKE $${params.length}
      )`);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM membership_ledger ml
      JOIN customer_memberships cm
        ON cm.id = ml.customer_membership_id
       AND cm.tenant_id = ml.tenant_id
      LEFT JOIN membership_plans mp
        ON mp.id = cm.plan_id
       AND mp.tenant_id = ml.tenant_id
      LEFT JOIN customers c
        ON c.id = cm.customer_id
       AND c.tenant_id = ml.tenant_id
      LEFT JOIN bookings b
        ON b.id = ml.booking_id
       AND b.tenant_id = ml.tenant_id
      LEFT JOIN services s
        ON s.id = b.service_id
       AND s.tenant_id = ml.tenant_id
      ${whereSql}
    `;
    const countResult = await db.query(countSql, params);
    const total = Number(countResult.rows?.[0]?.total || 0);

    const dataParams = [...params, limit, offset];
    const limitParam = `$${dataParams.length - 1}`;
    const offsetParam = `$${dataParams.length}`;

    const result = await db.query(
      `
      SELECT
        ml.id,
        ml.tenant_id,
        ml.customer_membership_id,
        ml.booking_id,
        ml.type,
        ml.minutes_delta,
        ml.uses_delta,
        ml.note,
        ml.created_at,
        cm.customer_id,
        cm.status AS membership_status,
        cm.start_at,
        cm.end_at,
        NULL AS minutes_remaining,
        NULL AS uses_remaining,
        c.name AS customer_name,
        c.email AS customer_email,
        c.phone AS customer_phone,
        mp.id AS plan_id,
        mp.name AS plan_name,
        b.service_id,
        b.start_time AS booking_start_time,
        s.name AS service_name
      FROM membership_ledger ml
      JOIN customer_memberships cm
        ON cm.id = ml.customer_membership_id
       AND cm.tenant_id = ml.tenant_id
      LEFT JOIN membership_plans mp
        ON mp.id = cm.plan_id
       AND mp.tenant_id = ml.tenant_id
      LEFT JOIN customers c
        ON c.id = cm.customer_id
       AND c.tenant_id = ml.tenant_id
      LEFT JOIN bookings b
        ON b.id = ml.booking_id
       AND b.tenant_id = ml.tenant_id
      LEFT JOIN services s
        ON s.id = b.service_id
       AND s.tenant_id = ml.tenant_id
      ${whereSql}
      ORDER BY ml.created_at DESC, ml.id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
      `,
      dataParams
    );

    const summary = result.rows.reduce(
      (acc, row) => {
        const rowType = String(row?.type || "").toLowerCase();
        acc.minutesDelta += Number(row?.minutes_delta || 0);
        acc.usesDelta += Number(row?.uses_delta || 0);
        if (rowType === "debit") acc.debitCount += 1;
        else if (rowType === "grant") acc.grantCount += 1;
        else if (rowType === "topup") acc.topUpCount += 1;
        else acc.otherCount += 1;
        if (row?.booking_id) acc.bookingLinkedCount += 1;
        return acc;
      },
      { minutesDelta: 0, usesDelta: 0, debitCount: 0, grantCount: 0, topUpCount: 0, otherCount: 0, bookingLinkedCount: 0 }
    );

    return res.json({
      ledger: result.rows,
      summary: {
        entryCount: total,
        minutesDelta: summary.minutesDelta,
        usesDelta: summary.usesDelta,
        debitCount: summary.debitCount,
        grantCount: summary.grantCount,
        topUpCount: summary.topUpCount,
        otherCount: summary.otherCount,
        bookingLinkedCount: summary.bookingLinkedCount,
      },
      meta: {
        total,
        limit,
        offset,
        hasMore: offset + result.rows.length < total,
      },
    });
  } catch (err) {
    console.error("GET /api/customer-memberships/ledger error:", err);
    return res.status(500).json({ error: "Failed to load membership ledger." });
  }
});

// Manually archive a membership (keeps the record but hides it from default lists)
// PATCH /api/customer-memberships/:id/archive?tenantSlug=...
};
