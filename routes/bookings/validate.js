'use strict';

// routes/bookings/validate.js
//
// Pre-BEGIN input + state validation for the booking creation engine.
// Extracted from routes/bookings/create.js (PR 2, Phase 1 refactor).
//
// Responsibility: parse and validate everything that can be checked before the
// transaction begins — request shape, tenant + auth identity, tenant policy
// (require-phone), startTime derivation and past-check, staff/resource
// per-tenant existence. No transaction state. Reads only; no writes.
//
// Error pattern: each exported function returns either
//   { ok: true, ...validatedFields }
// or
//   { ok: false, status, body }
// The orchestrator maps { ok: false } to `res.status(status).json(body)` —
// a 1-to-1 replacement for the inline `return res.status(...).json(...)` calls
// in the pre-extraction code. Throws are intentionally avoided so the outer
// `catch (err)` in create.js doesn't turn validation failures into 500s.

const db = require('../../db');

// ─── parseInputs(req) ───────────────────────────────────────────────────────
// Destructures req.body, validates slug + resolvedTenantId, applies auth
// gating (Google email OR admin bypass), derives requestedCustomerEmail, and
// enforces the raw startTime presence check.
//
// Returns all parsed body fields + derived values so the orchestrator can
// destructure once. The startTime presence check stays here (vs in
// deriveStartTime) so a request missing startTime fails BEFORE
// resolveCustomer runs — preserving the pre-extraction behavior that a
// missing-startTime request never creates a customer row.
function parseInputs(req) {
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
    prepaidEntitlementId,
    autoConsumePrepaid,
    requirePrepaid,
    paymentMethod: requestedPaymentMethod, // PAY-2: cash | card | cliq from client
    networkPaymentOrderId, // PAY-1: MPGS order ID when booking follows card payment
    // RENTAL-1: nightly booking fields
    booking_mode: incomingBookingMode,
    checkin_date,
    checkout_date,
    nights_count,
    // NIGHTLY SUITE: add-ons and guests
    addons_json: incomingAddonsJson,
    guests_count: incomingGuestsCount,
  } = req.body || {};

  const slug = (req.tenantSlug || tenantSlug || '').toString().trim();
  const resolvedTenantId = Number(req.tenantId || 0);
  if (!slug) {
    return { ok: false, status: 400, body: { error: 'Missing tenantSlug.' } };
  }
  if (!Number.isFinite(resolvedTenantId) || resolvedTenantId <= 0) {
    return { ok: false, status: 400, body: { error: 'Invalid tenant.' } };
  }

  const isAdminBypass = !!req.adminBypass;

  const googleEmail = (req.auth?.email || req.googleUser?.email || '').toString().trim().toLowerCase();
  const googleName = (req.auth?.name || req.googleUser?.name || req.googleUser?.given_name || '').toString().trim();

  // Public booking requires the *customer* Google identity.
  // Owner/tenant dashboards may create bookings on behalf of customers via ADMIN_API_KEY proxy.
  if (!isAdminBypass && !googleEmail) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }

  const requestedCustomerEmail = (isAdminBypass ? String(customerEmail || '') : String(googleEmail || ''))
    .trim()
    .toLowerCase();

  if (isAdminBypass && !requestedCustomerEmail) {
    return {
      ok: false,
      status: 400,
      body: { error: 'customerEmail is required for staff/admin bookings.' },
    };
  }

  // Raw startTime presence — kept here (vs deriveStartTime) to preserve
  // pre-extraction behavior: missing-startTime requests must fail before
  // resolveCustomer runs, so they never create a customer row.
  if (!startTime) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Missing required fields (startTime).' },
    };
  }

  return {
    ok: true,
    // raw body fields needed downstream
    serviceId,
    startTime,
    durationMinutes,
    customerName,
    customerPhone,
    customerEmail,
    staffId,
    resourceId,
    customerId,
    customerMembershipId,
    autoConsumeMembership,
    requireMembership,
    prepaidEntitlementId,
    autoConsumePrepaid,
    requirePrepaid,
    requestedPaymentMethod,
    networkPaymentOrderId,
    incomingBookingMode,
    checkin_date,
    checkout_date,
    nights_count,
    incomingAddonsJson,
    incomingGuestsCount,
    // derived
    slug,
    resolvedTenantId,
    isAdminBypass,
    googleEmail,
    googleName,
    requestedCustomerEmail,
  };
}

// ─── loadRequirePhonePolicy(tenantId) ───────────────────────────────────────
// Tenant policy: require customer phone unless explicitly disabled.
// Schema-free Phase C: read from tenants.branding JSONB when available.
// Defaults to true on lookup failure or missing/unparseable values.
async function loadRequirePhonePolicy(tenantId) {
  let requirePhone = true;
  try {
    const tpol = await db.query(`SELECT branding FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
    const branding = tpol.rows?.[0]?.branding || {};
    const v = branding?.require_phone ?? branding?.requirePhone ?? branding?.phone_required ?? branding?.phoneRequired;
    if (typeof v === 'boolean') requirePhone = v;
    if (typeof v === 'string' && v.trim() !== '') {
      requirePhone = ['1', 'true', 'yes', 'y'].includes(v.trim().toLowerCase());
    }
  } catch (_) {
    // keep default
  }
  return requirePhone;
}

// ─── deriveStartTime({ startTime, checkin_date, incomingBookingMode }) ──────
// Derives resolvedStartTime (nightly mode may derive from checkin_date),
// validates the date is well-formed, and rejects past times.
// Returns { resolvedStartTime, start, isNightlyBooking } on success.
function deriveStartTime({ startTime, checkin_date, incomingBookingMode }) {
  const isNightlyBooking = incomingBookingMode === 'nightly';
  let resolvedStartTime = startTime;

  const start = new Date(resolvedStartTime);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, status: 400, body: { error: 'Invalid startTime.' } };
  }

  const now = new Date();
  // Nightly: allow same-day check-in (compare against today midnight)
  const pastThreshold = isNightlyBooking
    ? (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })()
    : now.getTime() - 60 * 1000;
  if (start.getTime() < pastThreshold) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Cannot create a booking in the past.' },
    };
  }

  return { ok: true, resolvedStartTime, start, isNightlyBooking };
}

// ─── validateStaffAndResource({ staffId, resourceId, tenantId }) ────────────
// Parses staff_id / resource_id from the request and confirms each is a
// member of the tenant via a single LIMIT 1 SELECT each. Called after
// service load to preserve pre-extraction call ordering (so any error
// surface order — service error vs staff error — stays identical).
async function validateStaffAndResource({ staffId, resourceId, tenantId }) {
  const staff_id = staffId ? Number(staffId) : null;
  const resource_id = resourceId ? Number(resourceId) : null;

  if (staff_id) {
    const st = await db.query(
      `SELECT id FROM staff WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [staff_id, tenantId]
    );
    if (!st.rows.length) {
      return { ok: false, status: 400, body: { error: 'staffId not valid for tenant.' } };
    }
  }
  if (resource_id) {
    const rr = await db.query(
      `SELECT id FROM resources WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [resource_id, tenantId]
    );
    if (!rr.rows.length) {
      return { ok: false, status: 400, body: { error: 'resourceId not valid for tenant.' } };
    }
  }
  return { ok: true, staff_id, resource_id };
}

module.exports = {
  parseInputs,
  loadRequirePhonePolicy,
  deriveStartTime,
  validateStaffAndResource,
};
