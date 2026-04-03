// utils/bookingRouteHelpers.js
// Shared helpers extracted from routes/bookings.js

const db = require("../db");
const { pool } = require("../db");
const requireAppAuth = require("../middleware/requireAppAuth");
const { requireTenant } = require("../middleware/requireTenant");
const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
const { ensureBookingMoneyColumns } = require("../utils/ensureBookingMoneyColumns");
const { buildDashboardAlerts } = require("../utils/buildDashboardAlerts");
const { buildNoShowMetrics } = require("../utils/buildNoShowMetrics");
const { bookingQueryBuilder } = require("../utils/bookingQueryBuilder");

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
// Prepaid helpers
// ---------------------------------------------------------------------------

async function prepaidTablesExist(client) {
  try {
    const r = await client.query(`
      SELECT
        to_regclass('public.prepaid_products') AS prepaid_products,
        to_regclass('public.customer_prepaid_entitlements') AS customer_prepaid_entitlements,
        to_regclass('public.prepaid_transactions') AS prepaid_transactions,
        to_regclass('public.prepaid_redemptions') AS prepaid_redemptions
    `);
    const row = r.rows?.[0] || {};
    return !!row.prepaid_products && !!row.customer_prepaid_entitlements && !!row.prepaid_transactions && !!row.prepaid_redemptions;
  } catch {
    return false;
  }
}

async function resolvePrepaidSelection(client, { tenantId, customerId, entitlementId, serviceId }) {
  if (!customerId) return null;
  const params = [tenantId, customerId];
  const where = [
    'e.tenant_id = $1',
    'e.customer_id = $2',
    "COALESCE(e.status, 'active') = 'active'",
    'COALESCE(e.remaining_quantity, 0) > 0',
    '(e.expires_at IS NULL OR e.expires_at > NOW())',
    'COALESCE(p.is_active, true) = true',
  ];
  if (entitlementId) {
    params.push(Number(entitlementId));
    where.push(`e.id = $${params.length}`);
  }
  if (serviceId) {
    params.push(Number(serviceId));
    where.push(`(
      p.eligible_service_ids IS NULL
      OR jsonb_typeof(p.eligible_service_ids) <> 'array'
      OR jsonb_array_length(p.eligible_service_ids) = 0
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(p.eligible_service_ids) AS svc(value)
        WHERE svc.value = $${params.length}::text
      )
    )`);
  }
  const q = await client.query(
    `SELECT
       e.*,
       p.name AS prepaid_product_name,
       p.product_type,
       p.credit_amount,
       p.session_count,
       p.minutes_total,
       p.currency,
       p.eligible_service_ids,
       p.rules
     FROM customer_prepaid_entitlements e
     JOIN prepaid_products p
       ON p.id = e.prepaid_product_id
      AND p.tenant_id = e.tenant_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.updated_at DESC, e.id DESC
     LIMIT 1
     FOR UPDATE`,
    params
  );
  return q.rows?.[0] || null;
}

function computePrepaidRedemptionSelection(entitlement, durationMinutes, serviceDurationMinutes) {
  const minutesTotal = Number(entitlement?.minutes_total || 0);
  const creditAmount = Number(entitlement?.credit_amount || 0);
  const sessionCount = Number(entitlement?.session_count || 0);
  const bookingMinutes = Math.max(0, Number(durationMinutes || 0));
  const serviceUnitMinutes = Math.max(0, Number(serviceDurationMinutes || 0));
  if (minutesTotal > 0) {
    return { redeemedQuantity: Math.max(1, bookingMinutes), redemptionMode: 'minute' };
  }
  if (creditAmount > 0) {
    return { redeemedQuantity: 1, redemptionMode: 'credit' };
  }
  if (sessionCount > 0) {
    const packageUses = serviceUnitMinutes > 0 && bookingMinutes > 0
      ? Math.max(1, Math.ceil(bookingMinutes / serviceUnitMinutes))
      : 1;
    return { redeemedQuantity: packageUses, redemptionMode: 'package_use' };
  }
  return { redeemedQuantity: 1, redemptionMode: 'manual' };
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

module.exports = { shouldUseCustomerHistory, checkBlackoutOverlap, servicesHasColumn, getServiceAllowMembership, getIdempotencyKey, mustHaveTenantSlug, canTransitionStatus, bumpTenantBookingChange, prepaidTablesExist, resolvePrepaidSelection, computePrepaidRedemptionSelection, loadMembershipCheckoutPolicy, roundUpMinutes, buildMembershipResolution, buildMembershipInsufficientPayload };
