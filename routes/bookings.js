// routes/bookings.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
const requireGoogleAuth = require("../middleware/requireGoogleAuth");
const { requireTenant } = require("../middleware/requireTenant");
const { ensureBookingMoneyColumns } = require("../utils/ensureBookingMoneyColumns");
const { checkConflicts, loadJoinedBookingById } = require("../utils/bookings");

function shouldUseCustomerHistory(req) {
  // Frontend booking page currently calls /api/bookings with customerId/customerEmail.
  // We treat that as a customer-history request (Google-authenticated), otherwise this
  // remains the admin bookings endpoint.
  const q = req.query || {};
  return Boolean(q.customerId || q.customerEmail);
}

// Blackout windows (closures)
async function checkBlackoutOverlap({
  tenantId,
  startTime,
  endTime,
  resourceId,
  staffId,
  serviceId,
}) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return null;

  const startIso = typeof startTime === "string" ? startTime : new Date(startTime).toISOString();
  const endIso = typeof endTime === "string" ? endTime : new Date(endTime).toISOString();

  const rid = resourceId != null && resourceId !== "" ? Number(resourceId) : null;
  const sid = staffId != null && staffId !== "" ? Number(staffId) : null;
  const svc = serviceId != null && serviceId !== "" ? Number(serviceId) : null;

  const r = await db.query(
    `
    SELECT id, starts_at, ends_at, reason, resource_id, staff_id, service_id
    FROM tenant_blackouts
    WHERE tenant_id = $1
      AND is_active = TRUE
      AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      AND (resource_id IS NULL OR resource_id = $4)
      AND (staff_id IS NULL OR staff_id = $5)
      AND (service_id IS NULL OR service_id = $6)
    ORDER BY starts_at ASC
    LIMIT 1
    `,
    [tid, startIso, endIso, rid, sid, svc]
  );

  return r.rows?.[0] || null;
}

// ---------------------------------------------------------------------------
// Membership eligibility (service-level rule)
// ---------------------------------------------------------------------------
async function servicesHasColumn(client, columnName) {
  const { rows } = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='services'
      AND column_name = $1
    LIMIT 1
    `,
    [String(columnName)]
  );
  return rows.length > 0;
}

async function getServiceAllowMembership(client, tenantId, serviceId) {
  const tid = Number(tenantId);
  const sid = Number(serviceId);
  if (!Number.isFinite(tid) || tid <= 0) return { supported: false, allowed: false };
  if (!Number.isFinite(sid) || sid <= 0) return { supported: false, allowed: false };

  const supported = await servicesHasColumn(client, "allow_membership");
  if (!supported) {
    // Backward compatible: if the schema hasn't been patched yet,
    // we treat the rule as "not configured" (allowed=false) so we never silently debit.
    return { supported: false, allowed: false };
  }

  const r = await client.query(
    `SELECT COALESCE(allow_membership,false) AS allow_membership
     FROM services
     WHERE id=$1 AND tenant_id=$2
     LIMIT 1`,
    [sid, tid]
  );
  if (!r.rows.length) return { supported: true, allowed: false };
  return { supported: true, allowed: !!r.rows[0].allow_membership };
}

// ---------------------------------------------------------------------------
// Phase 0 safety helpers
// ---------------------------------------------------------------------------
function getIdempotencyKey(req) {
  const headerKey = req.get("Idempotency-Key") || req.get("idempotency-key");
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  const raw = headerKey || bodyKey;
  const key = raw ? String(raw).trim() : "";
  // keep it simple; DB constraint + uniqueness does the heavy lifting
  return key || null;
}

function mustHaveTenantSlug(req, res) {
  const slug = (req.query?.tenantSlug ?? req.body?.tenantSlug ?? "")
    .toString()
    .trim();
  if (!slug) {
    res.status(400).json({ error: "tenantSlug is required." });
    return null;
  }
  return slug;
}

function canTransitionStatus(fromStatus, toStatus) {
  const from = String(fromStatus || "").toLowerCase();
  const to = String(toStatus || "").toLowerCase();
  if (!from || !to) return false;
  if (from === to) return true; // idempotent

  const allowed = {
    pending: new Set(["confirmed", "cancelled"]),
    confirmed: new Set(["cancelled"]),
    cancelled: new Set([]),
  };
  return Boolean(allowed[from] && allowed[from].has(to));
}

// ---------------------------------------------------------------------------
// Heartbeat nudge helper
// IMPORTANT: Must bump the real DB column tenants.last_booking_change_at
// (and also keep the JSONB branding.system.lastBookingChangeAt for compatibility).
// ---------------------------------------------------------------------------
async function bumpTenantBookingChange(tenantId) {
  try {
    const tid = Number(tenantId);
    if (!Number.isFinite(tid) || tid <= 0) return;

    // 1) Bump canonical column (what your DB screenshots are checking)
    await db.query(
      `
      UPDATE tenants
      SET last_booking_change_at = NOW()
      WHERE id = $1
      `,
      [tid]
    );

    // 2) Also bump legacy JSONB signal (best-effort; do not fail if branding is null)
    await db.query(
      `
      UPDATE tenants
      SET branding = jsonb_set(
        (CASE WHEN jsonb_typeof(branding) = 'object' THEN branding ELSE '{}'::jsonb END),
        '{system,lastBookingChangeAt}',
        to_jsonb($2::text),
        true
      )
      WHERE id = $1
      `,
      [tid, new Date().toISOString()]
    );
  } catch (err) {
    // best-effort; never fail booking flows because of heartbeat
    console.warn("Failed to bump tenant booking heartbeat:", err?.message || err);
  }
}



// ---------------------------------------------------------------------------
// Membership checkout policy (tenant-controlled, JSONB-driven)
// Stored in tenants.branding.membershipCheckout (and/or legacy paths)
// ---------------------------------------------------------------------------
async function loadMembershipCheckoutPolicy(client, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return null;

  // Default policy (Flexrz recommended)
  const defaults = {
    mode: "smart_top_up", // smart_top_up | renew_upgrade | strict | off
    topUp: {
      enabled: true,
      allowSelfServe: true,
      // price per minute (so any interval works); UI can show per hour derived
      pricePerMinute: 0, // 0 = not priced (still can top-up if tenant uses offline payment)
      currency: null,
      // rounding rules for UX + accounting (minutes)
      roundToMinutes: 30,
      minPurchaseMinutes: 30,
    },
    renewUpgrade: { enabled: true },
    strict: { enabled: false },
  };

  try {
    const r = await client.query(
      `
      SELECT
        COALESCE(branding, '{}'::jsonb) AS branding,
        currency_code
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [tid]
    );
    if (!r.rows.length) return defaults;

    const branding = r.rows[0]?.branding || {};
    const currency = r.rows[0]?.currency_code || null;

    // Support multiple possible JSON paths (schema evolves)
    const maybe =
      branding?.membershipCheckout ||
      branding?.membership_checkout ||
      branding?.membership?.checkout ||
      branding?.membership?.checkoutPolicy ||
      null;

    const merged = { ...defaults, ...(maybe && typeof maybe === "object" ? maybe : {}) };
    merged.topUp = { ...defaults.topUp, ...(merged.topUp || {}) };
    merged.renewUpgrade = { ...defaults.renewUpgrade, ...(merged.renewUpgrade || {}) };
    merged.strict = { ...defaults.strict, ...(merged.strict || {}) };

    // Currency fallback
    if (!merged.topUp.currency) merged.topUp.currency = currency;

    return merged;
  } catch (e) {
    // best-effort: never fail booking because of policy read
    return defaults;
  }
}

function roundUpMinutes(value, roundTo) {
  const v = Math.max(0, Number(value || 0));
  const r = Math.max(1, Number(roundTo || 1));
  return Math.ceil(v / r) * r;
}

function buildMembershipResolution({ policy, minutesShort, usesShort }) {
  const p = policy || {};
  const mode = String(p.mode || "smart_top_up");

  const out = {
    mode,
    options: [],
    topUp: null,
    renewUpgrade: null,
    strict: null,
  };

  // Smart Top-Up
  if (p?.topUp?.enabled && (minutesShort > 0 || usesShort > 0)) {
    const roundTo = Number(p?.topUp?.roundToMinutes || 1);
    const minBuy = Number(p?.topUp?.minPurchaseMinutes || 0);
    const minsNeededRaw = minutesShort > 0 ? Number(minutesShort) : 0;
    const minsNeededRounded = Math.max(roundUpMinutes(minsNeededRaw, roundTo), minBuy || 0);

    const pricePerMinute = Number(p?.topUp?.pricePerMinute || 0);
    const currency = p?.topUp?.currency || null;
    const price = pricePerMinute > 0 ? Math.round(minsNeededRounded * pricePerMinute * 100) / 100 : null;

    out.topUp = {
      enabled: true,
      allowSelfServe: !!p?.topUp?.allowSelfServe,
      minutesNeeded: minsNeededRounded || null,
      usesNeeded: usesShort > 0 ? Number(usesShort) : null,
      price,
      currency,
    };
    out.options.push("top_up");
  }

  // Renew / Upgrade
  if (p?.renewUpgrade?.enabled) {
    out.renewUpgrade = { enabled: true };
    out.options.push("renew_upgrade");
  }

  // Strict
  if (p?.strict?.enabled || mode === "strict") {
    out.strict = { enabled: true };
    out.options.push("strict");
  }

  // If tenant explicitly wants strict, override options
  if (mode === "strict") {
    out.options = ["renew_upgrade"]; // no top-up fallback in strict mode
    out.topUp = null;
    out.strict = { enabled: true };
  }

  return out;
}

function buildMembershipInsufficientPayload({ policy, durationMinutes, membershipBefore, membershipId }) {
  const minsRemaining = Number(membershipBefore?.minutes_remaining || 0);
  const usesRemaining = Number(membershipBefore?.uses_remaining || 0);
  const dur = Math.max(0, Number(durationMinutes || 0));

  // Compute shortage: prefer minutes shortage when member has minutes bucket; otherwise minutes shortage for duration.
  let minutesShort = 0;
  let usesShort = 0;

  if (minsRemaining > 0) {
    minutesShort = Math.max(0, dur - minsRemaining);
  } else if (usesRemaining > 0) {
    usesShort = 0;
  } else {
    minutesShort = dur;
    usesShort = 0;
  }

  const resolution = buildMembershipResolution({ policy, minutesShort, usesShort });
  return {
    error: "membership_insufficient_balance",
    message: "Insufficient membership balance.",
    resolution: { ...resolution, membershipId: membershipId || null },
  };
}

// ---------------------------------------------------------------------------
// GET /api/bookings?tenantSlug|tenantId=...
// (unchanged)
// ---------------------------------------------------------------------------

// CUSTOMER: booking history (backward compatible with the public booking UI)
//
// The booking UI uses NEXTAUTH (Google) and calls the backend through /api/proxy
// with an Authorization: Bearer <googleIdToken> header. Previously it incorrectly
// hit the admin-only /api/bookings route, which caused 401s. This handler detects
// customer history requests (customerId/customerEmail) and authorizes them via
// requireGoogleAuth instead.
router.get(
  "/",
  (req, _res, next) => {
    if (shouldUseCustomerHistory(req)) return next();
    return next("route");
  },
  requireGoogleAuth,
  requireTenant,
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const googleEmail = String(req.googleUser?.email || "").trim().toLowerCase();

      const qEmailRaw =
        (req.query.customerEmail ? String(req.query.customerEmail) : "") ||
        (req.query.customerEmailOrPhone ? String(req.query.customerEmailOrPhone) : "");
      const qEmail = String(qEmailRaw).trim().toLowerCase();

      if (!googleEmail) return res.status(401).json({ error: "Unauthorized" });
      if (qEmail && qEmail !== googleEmail) {
        return res.status(403).json({ error: "Forbidden" });
      }

      let customerId = req.query.customerId ? Number(req.query.customerId) : null;

      // If customerId provided, ensure it belongs to the signed-in Google email.
      if (customerId && Number.isFinite(customerId)) {
        const c = await db.query(
          `SELECT id, email FROM customers WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [tenantId, customerId]
        );
        if (c.rows.length === 0) return res.json({ bookings: [] });
        const rowEmail = String(c.rows[0].email || "").trim().toLowerCase();
        if (rowEmail !== googleEmail) return res.status(403).json({ error: "Forbidden" });
      } else {
        // Resolve customerId by email (preferred)
        const c = await db.query(
          `SELECT id FROM customers WHERE tenant_id = $1 AND lower(email) = $2 LIMIT 1`,
          [tenantId, googleEmail]
        );
        customerId = c.rows[0]?.id ?? null;
      }

      if (!customerId) return res.json({ bookings: [] });

      const result = await db.query(
        `
        SELECT
          b.id,
          b.start_at,
          b.end_at,
          b.status,
          s.name AS service_name,
          r.name AS resource_name
        FROM bookings b
        LEFT JOIN services s ON s.id = b.service_id
        LEFT JOIN resources r ON r.id = b.resource_id
        WHERE b.tenant_id = $1 AND b.customer_id = $2
        ORDER BY b.start_at DESC
        LIMIT 200
        `,
        [tenantId, customerId]
      );

      return res.json({ bookings: result.rows || [] });
    } catch (err) {
      console.error("Customer bookings history error:", err);
      return res.status(500).json({ error: "Failed to load bookings" });
    }
  }
);

// ADMIN: bookings list (owner dashboard)
router.get("/", requireAdminOrTenantRole("staff"), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // ---- parse params ----
    const scopeRaw =
      (req.query.scope ? String(req.query.scope) : "") ||
      (req.query.view ? String(req.query.view) : "");
    const scope = (scopeRaw || "upcoming").toLowerCase(); // upcoming|past|range|all

    const status = req.query.status ? String(req.query.status).trim() : null;

    const serviceId = req.query.serviceId ? Number(req.query.serviceId) : null;
    const staffId = req.query.staffId ? Number(req.query.staffId) : null;
    const resourceId = req.query.resourceId ? Number(req.query.resourceId) : null;
    const customerId = req.query.customerId ? Number(req.query.customerId) : null;

    const query = req.query.query ? String(req.query.query).trim() : "";

    const limitRaw = req.query.limit ? Number(req.query.limit) : 50;
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));

    const cursorStartTime = req.query.cursorStartTime
      ? new Date(String(req.query.cursorStartTime))
      : null;
    const cursorId = req.query.cursorId ? Number(req.query.cursorId) : null;

    const cursorCreatedAt = req.query.cursorCreatedAt
      ? new Date(String(req.query.cursorCreatedAt))
      : null;

    if (cursorStartTime && Number.isNaN(cursorStartTime.getTime())) {
      return res.status(400).json({ error: "Invalid cursorStartTime." });
    }

    if (cursorCreatedAt && Number.isNaN(cursorCreatedAt.getTime())) {
      return res.status(400).json({ error: "Invalid cursorCreatedAt." });
    }
    if (cursorId != null && (!Number.isFinite(cursorId) || cursorId <= 0)) {
      return res.status(400).json({ error: "Invalid cursorId." });
    }

    // from/to
    const fromTs = req.query.from ? new Date(String(req.query.from)) : null;
    const toTs = req.query.to ? new Date(String(req.query.to)) : null;

    if (fromTs && Number.isNaN(fromTs.getTime())) return res.status(400).json({ error: "Invalid from." });
    if (toTs && Number.isNaN(toTs.getTime())) return res.status(400).json({ error: "Invalid to." });

    // ---- build WHERE ----
    const params = [tenantId];
    const where = ["b.tenant_id = $1"];

    // scope defaults
    if (scope === "upcoming") {
      where.push(`b.start_time >= NOW()`);
    } else if (scope === "past") {
      where.push(`b.start_time < NOW()`);
    } else if (scope === "range") {
      // rely on from/to
    } else if (scope === "all" || scope === "latest") {
      // no implicit time filter
    } else {
      // treat unknown scope as upcoming
      where.push(`b.start_time >= NOW()`);
    }

    if (fromTs) {
      params.push(fromTs.toISOString());
      where.push(`b.start_time >= $${params.length}`);
    }
    if (toTs) {
      params.push(toTs.toISOString());
      where.push(`b.start_time < $${params.length}`);
    }

    if (status && status !== "all") {
      params.push(status);
      where.push(`b.status = $${params.length}`);
    }

    if (Number.isFinite(serviceId) && serviceId > 0) {
      params.push(serviceId);
      where.push(`b.service_id = $${params.length}`);
    }
    if (Number.isFinite(staffId) && staffId > 0) {
      params.push(staffId);
      where.push(`b.staff_id = $${params.length}`);
    }
    if (Number.isFinite(resourceId) && resourceId > 0) {
      params.push(resourceId);
      where.push(`b.resource_id = $${params.length}`);
    }
    if (Number.isFinite(customerId) && customerId > 0) {
      params.push(customerId);
      where.push(`b.customer_id = $${params.length}`);
    }

    // Search (booking_code + customer fields). Uses LEFT JOIN customers.
    if (query) {
      params.push(`%${query}%`);
      const p = `$${params.length}`;
      where.push(
        `(
          b.booking_code ILIKE ${p}
          OR b.customer_name ILIKE ${p}
          OR b.customer_phone ILIKE ${p}
          OR b.customer_email ILIKE ${p}
          OR c.name ILIKE ${p}
          OR c.phone ILIKE ${p}
          OR c.email ILIKE ${p}
        )`
      );
    }

    // ---- order + keyset cursor ----
    const isPast = scope === "past";
    const isLatest = scope === "latest";

    const orderDir = (isPast || isLatest) ? "DESC" : "ASC";
    const comparator = (isPast || isLatest) ? "<" : ">";

    if (isLatest) {
      if (cursorCreatedAt && cursorId) {
        params.push(cursorCreatedAt.toISOString());
        const pCreated = `$${params.length}`;
        params.push(cursorId);
        const pId = `$${params.length}`;
        where.push(`(b.created_at, b.id) ${comparator} (${pCreated}, ${pId})`);
      }
    } else {
      if (cursorStartTime && cursorId) {
        params.push(cursorStartTime.toISOString());
        const pStart = `$${params.length}`;
        params.push(cursorId);
        const pId = `$${params.length}`;
        where.push(`(b.start_time, b.id) ${comparator} (${pStart}, ${pId})`);
      }
    }

    const orderBy = isLatest
      ? `b.created_at ${orderDir}, b.id ${orderDir}`
      : `b.start_time ${orderDir}, b.id ${orderDir}`;

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

        b.customer_id,
        COALESCE(c.name, b.customer_name)   AS customer_name,
        COALESCE(c.phone, b.customer_phone) AS customer_phone,
        COALESCE(c.email, b.customer_email) AS customer_email,

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
router.get("/count", requireAdminOrTenantRole("staff"), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const scopeRaw =
      (req.query.scope ? String(req.query.scope) : "") ||
      (req.query.view ? String(req.query.view) : "");
    const scope = (scopeRaw || "upcoming").toLowerCase();

    const status = req.query.status ? String(req.query.status).trim() : null;

    const serviceId = req.query.serviceId ? Number(req.query.serviceId) : null;
    const staffId = req.query.staffId ? Number(req.query.staffId) : null;
    const resourceId = req.query.resourceId ? Number(req.query.resourceId) : null;
    const customerId = req.query.customerId ? Number(req.query.customerId) : null;

    const query = req.query.query ? String(req.query.query).trim() : "";

    const fromTs = req.query.from ? new Date(String(req.query.from)) : null;
    const toTs = req.query.to ? new Date(String(req.query.to)) : null;

    if (fromTs && Number.isNaN(fromTs.getTime())) return res.status(400).json({ error: "Invalid from." });
    if (toTs && Number.isNaN(toTs.getTime())) return res.status(400).json({ error: "Invalid to." });

    const params = [tenantId];
    const where = ["b.tenant_id = $1"];

    if (scope === "upcoming") where.push("b.start_time >= NOW()");
    else if (scope === "past") where.push("b.start_time < NOW()");
    else if (scope === "range") { /* rely on from/to */ }
    else if (scope === "all") { /* no implicit time filter */ }
    else where.push("b.start_time >= NOW()");

    if (fromTs) {
      params.push(fromTs.toISOString());
      where.push(`b.start_time >= $${params.length}`);
    }
    if (toTs) {
      params.push(toTs.toISOString());
      where.push(`b.start_time < $${params.length}`);
    }

    if (status && status !== "all") {
      params.push(status);
      where.push(`b.status = $${params.length}`);
    }

    if (Number.isFinite(serviceId) && serviceId > 0) {
      params.push(serviceId);
      where.push(`b.service_id = $${params.length}`);
    }
    if (Number.isFinite(staffId) && staffId > 0) {
      params.push(staffId);
      where.push(`b.staff_id = $${params.length}`);
    }
    if (Number.isFinite(resourceId) && resourceId > 0) {
      params.push(resourceId);
      where.push(`b.resource_id = $${params.length}`);
    }
    if (Number.isFinite(customerId) && customerId > 0) {
      params.push(customerId);
      where.push(`b.customer_id = $${params.length}`);
    }

    const joinCustomers = Boolean(query);
    if (query) {
      params.push(`%${query}%`);
      const p = `$${params.length}`;
      where.push(
        `(
          b.booking_code ILIKE ${p}
          OR b.customer_name ILIKE ${p}
          OR b.customer_phone ILIKE ${p}
          OR b.customer_email ILIKE ${p}
          OR c.name ILIKE ${p}
          OR c.phone ILIKE ${p}
          OR c.email ILIKE ${p}
        )`
      );
    }

    const sql = `
      SELECT COUNT(*)::int AS total
      FROM bookings b
      ${joinCustomers ? "LEFT JOIN customers c ON c.tenant_id=b.tenant_id AND c.id=b.customer_id" : ""}
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
router.get("/:id", requireAdminOrTenantRole("staff"), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    const result = await db.query(
      `SELECT id FROM bookings WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
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
router.patch("/:id/status", requireAdminOrTenantRole("staff"), requireTenant, async (req, res) => {
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
      `SELECT status FROM bookings WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
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

    const upd = await db.query(
      `UPDATE bookings
       SET status=$1
       WHERE id=$2 AND tenant_id=$3
       RETURNING id`,
      [nextStatus, bookingId, tenantId]
    );

    if (!upd.rows.length) return res.status(404).json({ error: "Booking not found." });

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
router.delete("/:id", requireAdminOrTenantRole("staff"), requireTenant, async (req, res) => {
  try {
    if (!mustHaveTenantSlug(req, res)) return;

    const tenantId = req.tenantId;
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Invalid booking id." });
    }

    const curRes = await db.query(
      `SELECT status FROM bookings WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [bookingId, tenantId]
    );
    if (!curRes.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const currentStatus = String(curRes.rows[0].status || "").toLowerCase();
    const nextStatus = "cancelled";

    if (!canTransitionStatus(currentStatus, nextStatus)) {
      return res.status(409).json({
        error: `Invalid status transition: ${currentStatus} → ${nextStatus}`,
      });
    }

    if (currentStatus !== nextStatus) {
      await db.query(
        `UPDATE bookings
         SET status='cancelled'
         WHERE id=$1 AND tenant_id=$2`,
        [bookingId, tenantId]
      );
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
router.post("/", requireGoogleAuth, requireTenant, async (req, res) => {
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
    } = req.body || {};

    const slug = (req.tenantSlug || tenantSlug || "").toString().trim();
    const resolvedTenantId = Number(req.tenantId || 0);
    if (!slug) return res.status(400).json({ error: "Missing tenantSlug." });
    if (!Number.isFinite(resolvedTenantId) || resolvedTenantId <= 0) {
      return res.status(400).json({ error: "Invalid tenant." });
    }

    const idemKey = getIdempotencyKey(req);

    const googleEmail = (req.googleUser?.email || "").toString().trim().toLowerCase();
    const googleName = (req.googleUser?.name || req.googleUser?.given_name || "").toString().trim();
    if (!googleEmail) return res.status(401).json({ error: "Unauthorized" });

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

    // Resolve or create customer for this tenant using Google email.
    // IMPORTANT: we NEVER trust customerId from the client for authenticated flows.
    let finalCustomerId = null;
    let finalCustomerName = googleName || String(customerName || "").trim() || "Customer";
    let finalCustomerPhone = String(customerPhone || "").trim() || null;
    let finalCustomerEmail = googleEmail;

    const existingCust = await db.query(
      `SELECT id, name, phone, email
       FROM customers
       WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)
       LIMIT 1`,
      [resolvedTenantId, googleEmail]
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
        [resolvedTenantId, finalCustomerName, finalCustomerPhone, googleEmail]
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

    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime." });
    }

    const now = new Date();
    if (start.getTime() < now.getTime() - 60 * 1000) {
      return res.status(400).json({ error: "Cannot create a booking in the past." });
    }

    let resolvedServiceId = serviceId ? Number(serviceId) : null;
    let duration = durationMinutes ? Number(durationMinutes) : null;
    let requiresConfirmation = false;
    let serviceDurationMinutes = null;
    let servicePriceAmount = null;
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
           AND column_name IN ('price_amount','price')`
      );
      const hasPriceAmount = priceCols.rows.some((r) => r.column_name === 'price_amount');
      const hasPriceLegacy = priceCols.rows.some((r) => r.column_name === 'price');
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
        `SELECT id, tenant_id, duration_minutes, ${priceExpr}${hasReqConf ? ", COALESCE(requires_confirmation,false) AS requires_confirmation" : ""}
         FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [resolvedServiceId, resolvedTenantId]
      );
      if (!sRes.rows.length)
        return res.status(400).json({ error: "Unknown serviceId for tenant." });

      if (hasReqConf) {
        requiresConfirmation = !!sRes.rows[0].requires_confirmation;
      }

      serviceDurationMinutes = Number(sRes.rows[0].duration_minutes || 0) || null;
      servicePriceAmount = sRes.rows[0].price_amount != null ? Number(sRes.rows[0].price_amount) : null;

      if (!duration) {
        duration = Number(sRes.rows[0].duration_minutes || 60) || 60;
      }

      requiresConfirmation = hasReqConf ? !!sRes.rows[0].requires_confirmation : true;
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
    });

    if (conflicts.conflict) {
      return res.status(409).json({
        error: "Booking conflicts with an existing booking.",
        conflicts,
      });
    }

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

      // Insert booking (idempotent)
      const initialStatus = requiresConfirmation ? "pending" : "confirmed";

      // Compute price + charge amounts.
      // - price_amount represents the booking's list price/value.
      // - charge_amount is what we actually charge (0 if covered by membership).
      // If booking duration differs from service duration, scale proportionally.
      let price_amount = null;
      if (servicePriceAmount != null && Number.isFinite(servicePriceAmount)) {
        const base = Number(servicePriceAmount);
        const svcDur = Number(serviceDurationMinutes || duration || 0);
        const dur = Number(duration || 0);
        if (svcDur > 0 && dur > 0 && dur !== svcDur) {
          price_amount = Math.round((base * (dur / svcDur)) * 100) / 100;
        } else {
          price_amount = Math.round(base * 100) / 100;
        }
      }
      const charge_amount = finalCustomerMembershipId ? 0 : price_amount;

      const hasMoneyCols = await ensureBookingMoneyColumns();

      let bookingId;
      let created = true;
      try {
        const baseCols = `tenant_id, service_id, staff_id, resource_id, start_time, duration_minutes,
             customer_id, customer_name, customer_phone, customer_email, status, idempotency_key, customer_membership_id`;

        const baseVals = [
            resolvedTenantId,
            resolvedServiceId,
            staff_id,
            resource_id,
            start.toISOString(),
            duration,
            finalCustomerId,
            cleanName,
            cleanPhone,
            cleanEmail,
            initialStatus,
            idemKey,
            finalCustomerMembershipId,
        ];

        let insertSql;
        let insertParams = baseVals;

        if (hasMoneyCols) {
          insertSql = `
          INSERT INTO bookings
            (${baseCols}, price_amount, charge_amount, currency_code)
          VALUES
            ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16)
          RETURNING id;
          `;
          insertParams = [...baseVals, price_amount, charge_amount, tenantCurrencyCode];
        } else {
          // Backwards-compatible: DB does not yet have money columns.
          // Apply the migration to enable revenue reporting.
          insertSql = `
          INSERT INTO bookings
            (${baseCols})
          VALUES
            ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12, $13)
          RETURNING id;
          `;
        }

        const insert = await client.query(insertSql, insertParams);
        bookingId = insert.rows[0].id;
      } catch (err) {
        if (idemKey && err && err.code === "23505") {
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
        } else {
          throw err;
        }
      }

      const firstLetter = cleanName.charAt(0).toUpperCase() || "X";
      const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const bookingCode = `${firstLetter}-${resolvedTenantId}-${resolvedServiceId || 0}-${ymd}-${bookingId}`;

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

      await client.query("COMMIT");

      // 🔥 This is the critical bump used by heartbeat + UI refresh
      await bumpTenantBookingChange(resolvedTenantId);

      const joined = await loadJoinedBookingById(bookingId, resolvedTenantId);
      return res.status(created ? 201 : 200).json({
        booking: joined,
        replay: !created,
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

module.exports = router;
