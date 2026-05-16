"use strict";

const express = require("express");
const db = require("../db");
const { pool } = require("../db");
const { getTenantBySlug } = require("../utils/tenants");
const { runSupportAgent, generateLandingCopy } = require("../utils/claudeService");
const requireAppAuth = require("../middleware/requireAppAuth");
// VOICE-PERF-1: 60s TTL cache for fetchBusinessContext + fetchCustomerData.
// Mutation routes call bustBusiness / bustCustomer / bustTenant on writes.
const aiContextCache = require("../utils/aiContextCache");

// ─────────────────────────────────────────────────────────────────────────────
// VOICE-FIX-1 (Bugs 2 + 3) — slotConfirmationCache
//
// Stops the agent from booking slots it never checked (fabrication, Bug 3)
// and adds a defensive inline conflict re-check at create time (double-
// booking, Bug 2). Single-instance in-process Map; if/when this backend
// scales horizontally, swap to Redis. Cache is keyed per (tenant, customer,
// service, dateISO) so different services/dates don't collide.
//
// TTL is 5 minutes — covers a typical voice booking conversation. Future
// per-tenant AI config panel will expose this as a tenant-configurable
// setting (alongside BYOK + $5 trial credit + 80%/100% gates).
// TODO: tenant-configurable per AI config roadmap.
// ─────────────────────────────────────────────────────────────────────────────
const SLOT_CACHE_TTL_MS = 5 * 60 * 1000;
const slotConfirmationCache = (() => {
  const store = new Map();
  function key(tenantId, customerId, serviceId, dateISO) {
    return `${tenantId}:${customerId || 0}:${serviceId}:${dateISO}`;
  }
  function set(tenantId, customerId, serviceId, dateISO, slots) {
    store.set(key(tenantId, customerId, serviceId, dateISO), {
      slots: (slots || []).map(s => ({ time: s.time, resource_id: s.resource_id ?? null })),
      cachedAt: Date.now(),
    });
  }
  function get(tenantId, customerId, serviceId, dateISO) {
    const k = key(tenantId, customerId, serviceId, dateISO);
    const entry = store.get(k);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > SLOT_CACHE_TTL_MS) {
      store.delete(k);
      return null;
    }
    return entry;
  }
  function bustForBooking(tenantId, serviceId, dateISO) {
    // Bust ALL customer entries for this (tenant, service, date) — a write affects
    // every customer's view of that day's availability.
    const prefix = `${tenantId}:`;
    const suffix = `:${serviceId}:${dateISO}`;
    for (const k of store.keys()) {
      if (k.startsWith(prefix) && k.endsWith(suffix)) store.delete(k);
    }
  }
  function _resetForTests() { store.clear(); }
  return { set, get, bustForBooking, _resetForTests };
})();

// VOICE-FIX-1: Defensive inline conflict check used by create_booking before
// firing the actual /api/bookings write. Mirrors the overlap predicate used
// in availabilityEngine.js — same tstzrange && tstzrange pattern. Returns
// true if the slot has a conflicting booking (and therefore should be rejected).
async function hasConflictingBooking({ tenantId, resourceId, startISO, durationMin, maxParallel }) {
  if (!resourceId) return false; // no resource → can't conflict on resource
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM bookings
        WHERE tenant_id = $1
          AND resource_id = $2
          AND status IN ('pending','confirmed')
          AND deleted_at IS NULL
          AND booking_range && tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => $4), '[)')`,
      [tenantId, resourceId, startISO, durationMin]
    );
    const overlaps = Number(r.rows?.[0]?.n || 0);
    return overlaps >= (maxParallel || 1);
  } catch (e) {
    console.warn("[hasConflictingBooking] check failed, allowing booking:", e.message);
    return false; // fail-open: don't block on infra error
  }
}

const router = express.Router();
// Detect when user is confirming a previously discussed booking
function isConfirmationMessage(msg) {
  if (!msg) return false;
  const t = msg.toLowerCase().replace(/[!.?]/g, "").trim();
  // OPTION-A-FINAL (May 4, 2026): Arabic confirmation words added so voice
  // sessions in Arabic correctly trigger confirmationMode (turn N+1) and
  // route through the create_booking ACTION path.
  const patterns = [
    "yes", "yeah", "yep", "sure", "ok", "okay", "confirm", "confirmed",
    "go ahead", "book it", "do it", "please", "yes please", "yes confirm",
    "create it", "make it", "perfect", "great", "correct", "that works",
    "lets do it", "yes go ahead", "please do", "yes confirm it",
    // Arabic
    "نعم", "أكد", "احجز", "تمام", "اوكي", "اوك", "اكد", "اكيد",
    "تمام احجز", "نعم احجز", "احجزها", "اوك احجز",
  ];
  // Also match emoji-suffixed versions like "Yes, confirm it checkmark"
  const clean = t.replace(/[^a-z \u0600-\u06ff,]/g, "").trim();
  return patterns.some(p => clean === p || clean.startsWith(p + " ") || clean === "yes confirm it");
}

// Gate for isConfirmationMessage: only treat a "yes/ok/sure"-style reply as a
// booking confirmation when the prior assistant turn actually looked like a
// proposal awaiting yes/no. Without this, openers like "ok book sim 3 tonight"
// flip confirmationMode on turn 1 and the model is told to skip PENDING_BOOKING.
//
// English-only for now. Arabic-side gating is a follow-up: this helper falls
// open (returns false) for Arabic proposal turns, so the fallback path will
// under-trigger rather than over-trigger for Arabic — which is the safer
// failure mode (no false confirmations; at worst the model asks again).
function hasRecentPendingBooking(history) {
  if (!Array.isArray(history) || history.length === 0) return false;
  let lastAssistant = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === "assistant" && typeof m.content === "string") {
      lastAssistant = m.content;
      break;
    }
  }
  if (!lastAssistant) return false;
  const trimmed = lastAssistant.trim();
  const endsWithQuestion = /\?\s*$/.test(trimmed);
  const hasConfirmWord = /\b(confirm|shall i|book it|proceed|go ahead)\b/i.test(lastAssistant);
  return endsWithQuestion && hasConfirmWord;
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
  // VOICE-PERF-1: Cache lookup — saves ~300-500ms per voice/chat turn after
  // the first. Bust hooks fire from mutation routes (services CRUD, rate
  // rules, hours, blackouts, etc.) so dashboard edits surface immediately.
  const cached = aiContextCache.getBusiness(tenantId);
  if (cached) return cached;

  // Check every column before using it — schema varies between installs
  const [
    hasDescription, hasMaxParallel, hasMinSlots, hasAllowMem,
    hasCategoryId, hasPriceAmount, hasPrice, hasCurrencyCode,
    hasSlotInterval, hasMaxConsec, hasDeletedAt, hasIsActive, hasResourceIsActive,
    // resource / staff optional columns
    hasResourceCapacity, hasStaffEmail,
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
    columnExists("services", "is_active"),
    columnExists("resources", "is_active"),
    columnExists("resources", "capacity"),
    columnExists("staff", "email"),
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
  const activeWhere   = hasIsActive      ? "AND COALESCE(s.is_active, true) = true" : "";

  // membership_plans safe columns
  const mpBillingCol  = hasMpBillingType ? "billing_type"    : "NULL::text AS billing_type";
  const mpIncMinsCol  = hasMpIncMins     ? "included_minutes": "NULL::int AS included_minutes";
  const mpIncUsesCol  = hasMpIncUses     ? "included_uses"   : "NULL::int AS included_uses";
  const mpValidityCol = hasMpValidity    ? "validity_days"   : "NULL::int AS validity_days";
  const mpCurrencyCol = hasMpCurrency    ? "currency"        : "NULL::text AS currency";
  const mpDescCol     = hasMpDescription ? "description"     : "NULL::text AS description";

  const [servicesRes, membershipsRes, ratesRes, hoursRes, resourcesRes, staffRes, categoriesRes, packagesCheckRes, resourceLinksRes, staffLinksRes, serviceHoursRes] =
    await Promise.all([
      db.query(
        `SELECT s.id, s.name, ${descCol},
                s.duration_minutes, ${slotIntCol},
                ${maxConsecCol}, ${minSlotsCol},
                ${priceCol} AS price, ${currCol},
                ${parallelCol}, ${allowMemCol}, ${categoryCol}
         FROM services s
         WHERE s.tenant_id = $1
           ${activeWhere}
           ${deletedWhere}
         ORDER BY s.name ASC`,
        [tenantId]
      ).catch((e) => { console.error("[AI services query error]", e.message); return { rows: [] }; }),

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
        `SELECT id, name${hasResourceCapacity ? ", capacity" : ""}
         FROM resources
         WHERE tenant_id = $1${hasResourceIsActive ? " AND COALESCE(is_active, true) = true" : ""}
         ORDER BY name ASC`,
        [tenantId]
      ).catch(() => ({ rows: [] })),

      db.query(
        `SELECT id, name${hasStaffEmail ? ", email" : ""}${hasIsActive ? ", is_active" : ""}
         FROM staff
         WHERE tenant_id = $1${hasIsActive ? " AND COALESCE(is_active, true) = true" : ""}
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

      // VOICE-CONTEXT-1: Per-service operating hours (e.g. Karaoke 8pm–2am).
      // Used by the voice/text agent to explain rules when a customer asks
      // for a time outside the service window, instead of just saying
      // "no slots available".
      db.query(
        `SELECT service_id, day_of_week, open_time, close_time
         FROM service_hours
         WHERE tenant_id = $1
         ORDER BY service_id, day_of_week`,
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

  // If services query returned 0, retry WITHOUT is_active filter (handles inactive=false edge cases)
  let servicesRows = servicesRes.rows;
  if (servicesRows.length === 0 && hasIsActive) {
    try {
      const retryRes = await db.query(
        `SELECT s.id, s.name, ${descCol},
                s.duration_minutes, ${slotIntCol},
                ${maxConsecCol}, ${minSlotsCol},
                ${priceCol} AS price, ${currCol},
                ${parallelCol}, ${allowMemCol}, ${categoryCol}
         FROM services s
         WHERE s.tenant_id = $1
           ${deletedWhere}
         ORDER BY s.name ASC`,
        [tenantId]
      );
      servicesRows = retryRes.rows;
      if (servicesRows.length > 0) {
        console.log(`[AI ctx] Retried services without is_active filter — found ${servicesRows.length} services`);
      }
    } catch (e) {
      console.error("[AI services retry error]", e.message);
    }
  }

  // Retry resources without is_active filter if empty (handles is_active=false set explicitly)
  let resourcesRows = resourcesRes.rows;
  if (resourcesRows.length === 0) {
    try {
      const retryRes = await db.query(
        `SELECT id, name${hasResourceCapacity ? ", capacity" : ""} FROM resources WHERE tenant_id = $1 ORDER BY name ASC`,
        [tenantId]
      );
      resourcesRows = retryRes.rows;
      if (resourcesRows.length > 0) {
        console.log(`[AI ctx] Retried resources without is_active filter — found ${resourcesRows.length} resources`);
      }
    } catch (e) { console.error("[AI resources retry error]", e.message); }
  }

  // Retry staff without is_active filter if empty
  let staffRows = staffRes.rows;
  if (staffRows.length === 0) {
    try {
      const retryRes = await db.query(
        `SELECT id, name${hasStaffEmail ? ", email" : ""} FROM staff WHERE tenant_id = $1 ORDER BY name ASC`,
        [tenantId]
      );
      staffRows = retryRes.rows;
      if (staffRows.length > 0) {
        console.log(`[AI ctx] Retried staff without is_active filter — found ${staffRows.length} staff`);
      }
    } catch (e) { console.error("[AI staff retry error]", e.message); }
  }

  const result = {
    services: servicesRows,
    memberships: membershipsRes.rows,
    rates: ratesRes.rows,
    workingHours: hoursRes.rows,
    resources: resourcesRows,
    staff: staffRows,
    categories: categoriesRes.rows,
    prepaidProducts,
    resourceLinks: resourceLinksRes.rows,
    staffLinks: staffLinksRes.rows,
    serviceHours: serviceHoursRes.rows,
  };
  // Diagnostic: visible in Render logs — tells us exactly what each tenant's AI context contains
  console.log(`[AI ctx] tenant=${tenantSlug} services=${result.services.length} memberships=${result.memberships.length} resources=${result.resources.length} staff=${result.staff.length} isActiveColExists=${hasIsActive} resIsActiveColExists=${hasResourceIsActive}`);
  if (result.services.length > 0) {
    console.log(`[AI ctx services] ${result.services.map(s => s.name + "[id:" + s.id + "]").join(", ")}`);
  } else {
    console.log(`[AI ctx services] EMPTY — tenantId=${tenantId} hasIsActive=${hasIsActive}`);
  }
  // VOICE-PERF-1: Store in cache for subsequent turns within the 60s window.
  aiContextCache.setBusiness(tenantId, result);
  return result;
}

// ── Fetch full customer data ──────────────────────────────────────────
async function fetchCustomerData(tenantId, email) {
  if (!email) return null;

  // VOICE-PERF-1: Cache lookup. Bust hooks fire from bookings/create.js,
  // bookings/crud.js (cancel), customerMemberships routes, and prepaid
  // redemption — wherever a customer's balances or bookings change.
  const cached = aiContextCache.getCustomer(tenantId, email);
  if (cached) return cached;

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
       LEFT JOIN membership_plans mp ON mp.id = ${planIdCol} AND mp.tenant_id = $1
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
        // PAYMENT-FILTER-1 (May 4, 2026): include p.eligible_service_ids so
        // the AI prompt can render which services each package applies to.
        // Without this, Claude offered Lesson packages to pay for Sim Bay
        // bookings because the prompt only said "customer has packages" with
        // no eligibility constraint surfaced. The booking would then fail
        // server-side validation (resolvePrepaidSelection enforces it), but
        // by then the customer already heard "you can use your Lesson pack".
        `SELECT e.id, e.status, e.remaining_quantity, e.original_quantity,
                e.starts_at, e.expires_at,
                p.name AS product_name, p.product_type,
                p.session_count, p.minutes_total, p.credit_amount,
                p.eligible_service_ids
         FROM customer_prepaid_entitlements e
         LEFT JOIN prepaid_products p ON p.id = e.prepaid_product_id
         WHERE e.tenant_id = $1 AND e.customer_id = $2
         ORDER BY e.created_at DESC
         LIMIT 10`,
        [tenantId, customerId]
      ).catch(() => ({ rows: [] }));
    })(),
  ]);

  const result = {
    profile: customer,
    bookings: bookingsRes.rows,
    memberships: membershipsRes.rows,
    packages: packagesRes.rows,
  };
  // VOICE-PERF-1: Cache the customer view for the next turn within TTL.
  aiContextCache.setCustomer(tenantId, email, result);
  return result;
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

        // ─────────────────────────────────────────────────────────────
        // VOICE-FIX-3 (Bug 2): Multi-resource × multi-staff coverage.
        //
        // Previously this picked ONE resource (lowest id) when none was
        // specified, leaving the agent blind to whether other resources
        // were free. For Karaoke (Sim 1 + Sim 3), the agent reported
        // "available" based on Sim 1 alone, even when Sim 3 was booked.
        //
        // Now: query all linked resources × all linked staff (capped at 36
        // tuples per request — when bigger tenants need this, gate it
        // behind a tenant tier flag in the per-tenant AI config panel).
        // ─────────────────────────────────────────────────────────────
        const SLOT_TUPLE_CAP = 36;

        // Build candidate resource list
        let resourceCandidates = [];
        if (action.resource_id) {
          // Customer specified a resource — use only that one
          const r = await db.query(
            `SELECT id, name FROM resources WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
            [Number(action.resource_id), tenantId]
          ).catch(() => ({ rows: [] }));
          resourceCandidates = r.rows;
        } else {
          // No resource specified — fan out across all linked active resources
          const linked = await db.query(
            `SELECT r.id, r.name FROM resources r
             JOIN resource_service_links rsl ON rsl.resource_id = r.id
             WHERE rsl.service_id = $1 AND r.tenant_id = $2
               AND COALESCE(r.is_active, true) = true
             ORDER BY r.id ASC`,
            [action.service_id, tenantId]
          ).catch(() => ({ rows: [] }));
          resourceCandidates = linked.rows;
          if (resourceCandidates.length === 0) {
            // No linked resources — fall back to any active resource (legacy single-resource tenants)
            const any = await db.query(
              `SELECT id, name FROM resources
               WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
               ORDER BY id ASC LIMIT 1`,
              [tenantId]
            ).catch(() => ({ rows: [] }));
            resourceCandidates = any.rows;
          }
        }

        // Build candidate staff list
        let staffCandidates = [];
        if (action.staff_id) {
          const s = await db.query(
            `SELECT id, name FROM staff WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
            [Number(action.staff_id), tenantId]
          ).catch(() => ({ rows: [] }));
          staffCandidates = s.rows;
        } else if (service.requires_staff) {
          // Service requires staff — fan out across all linked active staff
          const linkedStaff = await db.query(
            `SELECT st.id, st.name FROM staff st
             JOIN staff_service_links ssl ON ssl.staff_id = st.id
             WHERE ssl.service_id = $1 AND st.tenant_id = $2
               AND COALESCE(st.is_active, true) = true
             ORDER BY st.id ASC`,
            [action.service_id, tenantId]
          ).catch(() => ({ rows: [] }));
          staffCandidates = linkedStaff.rows;
        }
        // Always include a "no staff" entry so the engine gets called even when service doesn't require staff
        if (staffCandidates.length === 0) staffCandidates = [{ id: null, name: null }];

        // If we ended up with no resources (service doesn't require resource), include a single null entry
        if (resourceCandidates.length === 0) resourceCandidates = [{ id: null, name: null }];

        // Cap the cartesian
        const allTuples = [];
        for (const r of resourceCandidates) {
          for (const s of staffCandidates) {
            allTuples.push({ resource: r, staff: s });
          }
        }
        let tuples = allTuples;
        let capHit = false;
        if (allTuples.length > SLOT_TUPLE_CAP) {
          tuples = allTuples.slice(0, SLOT_TUPLE_CAP);
          capHit = true;
          console.warn(`[AI availability] CAP HIT — ${allTuples.length} tuples truncated to ${SLOT_TUPLE_CAP}`);
        }

        const normalizedDate = normalizeDateInput(action.date);
        console.log(`[AI availability] service=${action.service_id} date=${normalizedDate} tuples=${tuples.length}/${allTuples.length} basis=${service.availability_basis}`);

        // Run the engine for each tuple in parallel
        const tupleResults = await Promise.all(
          tuples.map(async (t) => {
            const r = await buildAvailabilitySlots({
              tenantId,
              tenantSlug,
              date: normalizedDate,
              serviceId: Number(action.service_id),
              staffId: t.staff?.id ?? null,
              resourceId: t.resource?.id ?? null,
              tenantTz,
              service,
            });
            return { tuple: t, result: r };
          })
        );

        // ─────────────────────────────────────────────────────────────
        // VOICE-FIX-3 (Bug 3 part 2): Look up customer-id of conflicting
        // bookings so the agent can say "that's YOUR booking" vs "OTHER
        // customer". Side query — does NOT modify the engine.
        //
        // For each tuple, find which slots are NOT free and check who owns
        // the conflicting booking on that resource. If matches calling
        // customer → tag YOUR. Else tag OTHER. (Engine itself returns
        // is_available; we just enrich the busy ones.)
        // ─────────────────────────────────────────────────────────────
        const durationMin = Number(service.duration_minutes) || 60;

        // Helper: look up conflicting booking owner for a given (resource, time)
        async function lookupConflictOwner(resourceId, slotTimeISO) {
          if (!resourceId || !slotTimeISO) return null;
          try {
            const c = await db.query(
              `SELECT customer_id FROM bookings
                WHERE tenant_id = $1
                  AND resource_id = $2
                  AND status IN ('pending','confirmed')
                  AND deleted_at IS NULL
                  AND booking_range && tstzrange($3::timestamptz, $3::timestamptz + make_interval(mins => $4), '[)')
                ORDER BY id ASC LIMIT 1`,
              [tenantId, resourceId, slotTimeISO, durationMin]
            );
            return c.rows?.[0]?.customer_id ?? null;
          } catch (e) {
            return null;
          }
        }

        // Aggregate per timeslot — group resource/staff status by time
        // Shape: { "20:00": { resources: [{ name, free, ownership }], staff: [...], any_free: bool } }
        const slotsByTime = {};

        for (const { tuple, result } of tupleResults) {
          const slots = result.slots || [];
          for (const s of slots) {
            const t = s.time;
            if (!t) continue;
            if (!slotsByTime[t]) slotsByTime[t] = { resources: [], staff: [], any_free: false };
            const isFree = s.is_available !== false && s.available !== false;
            // Determine slot's UTC ISO for conflict lookup if needed
            // (slot.time is HH:MM in tenant TZ — combine with date)
            // We only need conflict lookup for BUSY slots on resource basis.
            if (tuple.resource?.id) {
              const existing = slotsByTime[t].resources.find(r => r.id === tuple.resource.id);
              if (!existing) {
                slotsByTime[t].resources.push({
                  id: tuple.resource.id,
                  name: tuple.resource.name,
                  free: isFree,
                  ownership: null, // filled in below if busy
                });
              } else if (isFree) {
                existing.free = true; // any tuple says free → resource is free at that time
              }
            }
            if (tuple.staff?.id) {
              const existing = slotsByTime[t].staff.find(st => st.id === tuple.staff.id);
              if (!existing) {
                slotsByTime[t].staff.push({
                  id: tuple.staff.id,
                  name: tuple.staff.name,
                  free: isFree,
                });
              } else if (isFree) {
                existing.free = true;
              }
            }
            if (isFree) slotsByTime[t].any_free = true;
          }
        }

        // For all BUSY resources, look up conflict owner (customer id)
        for (const [time, info] of Object.entries(slotsByTime)) {
          for (const r of info.resources) {
            if (r.free) continue;
            // Build slot ISO from date + time + tenant tz offset
            const slotISO = `${normalizedDate}T${time}:00`;
            // Use tenant tz to compute UTC. Simpler: format with offset from tzOffsetStr
            // We compute offset server-side using Intl
            const tzOffset = (() => {
              try {
                const offsetPart = new Intl.DateTimeFormat("en", {
                  timeZone: tenantTz, timeZoneName: "longOffset",
                }).formatToParts(new Date(`${normalizedDate}T${time}:00Z`)).find(p => p.type === "timeZoneName")?.value || "GMT+0";
                const m = offsetPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
                if (!m) return "+00:00";
                return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] || "00").padStart(2, "0")}`;
              } catch { return "+00:00"; }
            })();
            const conflictISO = `${slotISO}${tzOffset}`;
            const ownerId = await lookupConflictOwner(r.id, conflictISO);
            r.ownership = ownerId == null ? "BUSY"
                        : (Number(ownerId) === Number(customerId)) ? "YOUR"
                        : "OTHER";
          }
        }

        // Determine if there are ANY available slots overall
        const anyAvailable = Object.values(slotsByTime).some(v => v.any_free);

        // Get a reason from the first non-empty result for failure cases
        const firstResult = tupleResults[0]?.result;
        const reason = firstResult?.meta?.reason;
        if (!anyAvailable && reason && reason !== "ok" && reason !== "success") {
          const reasonMap = {
            tenant_closed: "The business is closed on that day.",
            resource_required: "This service requires a specific resource selection.",
            staff_required: "This service requires staff selection.",
            no_working_hours: "No working hours configured for that day.",
            invalid_working_hours: "Working hours configuration issue.",
            service_hours_outside_business_hours: "Service hours don't overlap with business hours that day.",
          };
          return {
            success: true, slots: [],
            message: reasonMap[reason] || `No slots available (${reason.replace(/_/g, " ")}).`,
          };
        }

        if (Object.keys(slotsByTime).length === 0) {
          return { success: true, slots: [], message: `No available slots on ${action.date}. The business may be closed or fully booked.` };
        }

        // Build the structured response: sorted by time
        const sortedTimes = Object.keys(slotsByTime).sort();
        const structuredSlots = sortedTimes.map(time => {
          const info = slotsByTime[time];
          return {
            time,
            any_free: info.any_free,
            resources: info.resources, // [{ id, name, free, ownership }]
            staff: info.staff,         // [{ id, name, free }]
          };
        });

        // Cache the slots for create_booking gate (Bug 2/3 of VOICE-FIX-1).
        // Only cache slots where at least one resource is free, and tag the
        // first-free resource per time so create_booking can verify.
        const slotsForCache = structuredSlots
          .filter(s => s.any_free)
          .map(s => {
            const firstFreeRes = s.resources.find(r => r.free);
            return {
              time: s.time,
              resource_id: firstFreeRes?.id ?? null,
            };
          });
        slotConfirmationCache.set(tenantId, customerId, Number(action.service_id), normalizedDate, slotsForCache);

        // Determine the resourceId to surface — either the customer's choice,
        // or "auto" if multiple are available
        const surfaceResourceId = action.resource_id
          ? Number(action.resource_id)
          : (resourceCandidates.length === 1 ? resourceCandidates[0]?.id : null);

        return {
          success: true,
          slots: structuredSlots.slice(0, 20),
          structured: true, // tells voice.js to format per-resource
          resourceId: surfaceResourceId,
          capHit,
          message: null,
        };
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

        // ── Timezone-safe start time parsing ─────────────────────────────
        // If Claude omitted the UTC offset (e.g. sent "2026-04-08T19:00:00" instead of
        // "2026-04-08T19:00:00+03:00"), new Date() on a UTC server would misinterpret it
        // as UTC — shifting the booking by the tenant's offset (e.g. +3h for Amman).
        // Safety net: if no offset present, ask Postgres to interpret as tenant local time.
        const tzRes = await db.query(`SELECT timezone FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
        const tenantTz = tzRes.rows?.[0]?.timezone || "Asia/Amman";

        let start;
        const rawTime = String(action.start_time);
        const hasOffset = /Z$|[+\-]\d{2}:?\d{2}$/.test(rawTime);

        if (hasOffset) {
          // Has explicit offset — parse directly (correct path)
          start = new Date(rawTime);
        } else {
          // No offset — treat as local time in tenant timezone via Postgres
          console.log(`[AI create_booking] WARNING: start_time "${rawTime}" has no UTC offset — interpreting as ${tenantTz} local time`);
          const pgRes = await db.query(
            `SELECT ($1::timestamp AT TIME ZONE $2) AS utc_time`,
            [rawTime, tenantTz]
          );
          start = new Date(pgRes.rows[0].utc_time);
        }

        if (isNaN(start.getTime())) return { success: false, message: "Invalid start time." };
        console.log(`[AI create_booking] parsed start=${start.toISOString()} from raw="${rawTime}" hasOffset=${hasOffset} tz=${tenantTz}`);

        // ─────────────────────────────────────────────────────────────────
        // VOICE-FIX-1 (Bugs 2 + 3): slot confirmation gate
        //
        // 1. Anti-fabrication: if the agent proposes a slot that wasn't in
        //    the most recent check_availability result, reject with the
        //    actual available times so the agent recovers cleanly.
        // 2. Anti-double-booking: re-validate against the DB at create time
        //    (a confirmed booking may have landed since the cache was filled).
        //
        // Both bugs were observed in production via Birdie smoke tests; this
        // gate makes them deterministic to prevent.
        // ─────────────────────────────────────────────────────────────────
        const dateISO = start.toLocaleDateString("en-CA", { timeZone: tenantTz }); // YYYY-MM-DD
        const timeHHMM = start.toLocaleTimeString("en-GB", { timeZone: tenantTz, hour: "2-digit", minute: "2-digit", hour12: false });
        const cached = slotConfirmationCache.get(tenantId, customerId, Number(action.service_id), dateISO);

        if (cached) {
          const inCache = cached.slots.some(s => s.time === timeHHMM);
          if (!inCache) {
            const offered = cached.slots.map(s => s.time).join(", ");
            console.warn(`[AI create_booking] FABRICATION BLOCKED — proposed ${timeHHMM} not in cached slots [${offered}]`);
            return {
              success: false,
              message: `I don't have ${timeHHMM} as an available slot on ${dateISO}. The available times I checked were: ${offered}. Which would you like?`,
            };
          }
        } else {
          console.log(`[AI create_booking] no cached slots for service=${action.service_id} date=${dateISO} — running inline conflict check only`);
        }

        // Defensive inline conflict re-check — covers both the no-cache path AND
        // the case where another booking landed between check_availability and now.
        const conflict = await hasConflictingBooking({
          tenantId,
          resourceId: action.resource_id ? Number(action.resource_id) : null,
          startISO: start.toISOString(),
          durationMin: duration,
          maxParallel: Number(svc.max_parallel_bookings) || 1,
        });
        if (conflict) {
          console.warn(`[AI create_booking] CONFLICT BLOCKED — slot ${timeHHMM} on ${dateISO} resource=${action.resource_id} just got booked`);
          // Bust the cache so the next check_availability returns fresh state
          slotConfirmationCache.bustForBooking(tenantId, Number(action.service_id), dateISO);
          return {
            success: false,
            message: `That slot was just taken — let me check what else is open. One moment.`,
          };
        }
        // ── End VOICE-FIX-1 gate ─────────────────────────────────────────

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
        // tenantTz already fetched above for timezone-safe start time parsing — reuse it here
        const displayTime = start.toLocaleString("en-GB", { timeZone: tenantTz, dateStyle: "full", timeStyle: "short" });

        // VOICE-FIX-1: a booking just landed → bust slot cache for this service+date
        // so the next check_availability call returns fresh state for any customer.
        slotConfirmationCache.bustForBooking(tenantId, Number(action.service_id), dateISO);

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
    const { message, history = [], authToken: clientAuthToken, pendingAction } = req.body;
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

    // ── DIRECT BOOKING via pendingAction (most reliable path) ─────────
    // Frontend sends pendingAction when user confirms a PENDING_BOOKING embedded by Claude
    if (pendingAction?.type === "create_booking" && pendingAction?.service_id && pendingAction?.start_time) {
      console.log("[AI] pendingAction received — executing directly:", JSON.stringify(pendingAction));
      const directResult = await handleAction(
        pendingAction, tenant.id, tenant.slug,
        customerData?.profile?.id || null, email, authToken
      );
      let directReply;
      if (directResult?.success && directResult?.bookingId) {
        directReply = directResult.message || "\u2705 Your booking has been confirmed!";
      } else {
        directReply = directResult?.message || "Something went wrong creating the booking. Please try via the booking form.";
      }
      return res.json({ reply: directReply, action: directResult });
    }

    const isConfirmation = isConfirmationMessage(message) && hasRecentPendingBooking(history);
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
          // VOICE-FIX-3 (Bug 2): Structured per-resource formatting matching voice.js
          if (actionResult.structured) {
            const lines = actionResult.slots.map(s => {
              const parts = [];
              if (s.resources && s.resources.length > 0) {
                const resStr = s.resources.map(r => {
                  if (r.free) return `${r.name} FREE`;
                  if (r.ownership === "YOUR")  return `${r.name} BOOKED (YOUR existing booking)`;
                  if (r.ownership === "OTHER") return `${r.name} BOOKED (other customer)`;
                  return `${r.name} BUSY`;
                }).join(", ");
                parts.push(resStr);
              }
              if (s.staff && s.staff.length > 0) {
                const stStr = s.staff.map(st => `${st.name} ${st.free ? "FREE" : "BUSY"}`).join(", ");
                parts.push(`staff: ${stStr}`);
              }
              return `  - ${s.time}: ${parts.join(" | ")}`;
            }).join("\n");
            const capNote = actionResult.capHit ? "\n(Showing first 36 resource/staff combinations — narrow by resource or staff for full coverage.)" : "";
            actionContext = `AVAILABILITY RESULT for ${action.date} (${actionResult.slots.length} slot times):\n${lines}${capNote}\n\nWhen relaying to the customer: name the specific free resources, flag any of YOUR existing bookings, and never claim "all sims free" without naming them.`;
          } else {
            // Legacy fallback (shouldn't fire post-VOICE-FIX-3)
            const slotTimes = actionResult.slots
              .map(s => s.time || s.label)
              .filter(Boolean)
              .slice(0, 15)
              .join(", ");
            actionContext = `AVAILABILITY RESULT: Found ${actionResult.slots.length} available slots on ${action.date}: ${slotTimes}. The resource_id to use is ${actionResult.resourceId || action.resource_id || "auto-selected"}.`;
          }
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

    // Parse and strip PENDING_BOOKING line that Claude embeds in confirmation messages
    let pendingBooking = null;
    const pbMatch = finalReply.match(/^PENDING_BOOKING:(\{[^\n\r]+\})\s*$/m);
    if (pbMatch) {
      try {
        pendingBooking = JSON.parse(pbMatch[1]);
        finalReply = finalReply.replace(/^PENDING_BOOKING:\{[^\n\r]+\}\s*$/m, "").trim();
        console.log("[AI] PENDING_BOOKING parsed:", JSON.stringify(pendingBooking));
      } catch (e) {
        console.error("[AI] PENDING_BOOKING parse error:", e.message);
      }
    }

    res.json({
      reply: finalReply,
      action: actionResult,
      pendingBooking,
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

// ── POST /api/ai/:tenantSlug/transcribe ──────────────────────────────
// Accepts a multipart audio file (webm/mp4/ogg/wav from MediaRecorder),
// converts it to text using Claude, returns { transcript: string }.
// This is the reliable cross-device alternative to Web Speech API,
// needed because Samsung Chrome silently breaks SpeechRecognition.
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

router.post("/:tenantSlug/transcribe", optionalAuth, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file received" });

    const { buffer, mimetype, originalname } = req.file;
    if (!buffer || buffer.length < 100) {
      return res.status(400).json({ error: "Audio file is empty or too short" });
    }

    // Determine media type — MediaRecorder on Android typically sends webm
    const mediaType = (mimetype && mimetype.startsWith("audio/")) ? mimetype : "audio/webm";

    // Use Claude to transcribe via the audio document block
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic();

    const base64Audio = buffer.toString("base64");

    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64Audio,
              },
            },
            {
              type: "text",
              text: "Please transcribe this audio recording exactly as spoken. Return only the transcribed text with no extra commentary, quotes, or formatting.",
            },
          ],
        },
      ],
    });

    const transcript = response.content?.[0]?.text?.trim() ?? "";
    console.log(`[AI transcribe] tenant=${req.params.tenantSlug} bytes=${buffer.length} transcript="${transcript.slice(0, 80)}"`);
    res.json({ transcript });
  } catch (err) {
    console.error("[AI transcribe error]", err?.message ?? err);
    res.status(500).json({ error: "Transcription failed, please try again" });
  }
});


module.exports = router;

// VOICE-2: expose helpers for routes/voice.js to reuse without duplication.
// These three functions encapsulate the entire chat brain's I/O — context
// fetch, action execution, confirmation detection. routes/voice.js calls
// them inside its booking-assistant tool bridge so the voice path produces
// identical results to the text path.
module.exports.fetchBusinessContext   = fetchBusinessContext;
module.exports.fetchCustomerData      = fetchCustomerData;
module.exports.handleAction           = handleAction;
module.exports.isConfirmationMessage  = isConfirmationMessage;
module.exports.hasRecentPendingBooking = hasRecentPendingBooking;
module.exports.optionalAuth           = optionalAuth;
// Phase 2.0 test net: __tests__/ai_voice_chat.test.js seeds and resets the
// in-process slot cache through this handle. Not used by production code.
module.exports._slotConfirmationCacheForTests = slotConfirmationCache;
