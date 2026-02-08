// utils/publish.js
// -----------------------------------------------------------------------------
// Phase 4: Tenant publish protocol helpers
// -----------------------------------------------------------------------------
// This module implements *read-only* publish validation logic and is used by
// the publish endpoints in routes/tenants.js.
//
// Design goals:
// - Zero hardcoding per tenant (all derived from DB state)
// - Safe, explainable validation (returns machine-readable errors)
// - Does NOT mutate state (mutation happens only in the publish endpoint)

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function countRows(val) {
  const n = Number(val || 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Validate whether a tenant is "publishable".
 *
 * Hard requirements (blocking errors):
 *  - tenant.name + tenant.timezone
 *  - at least 1 open day in tenant_hours
 *  - at least 1 active service
 *  - capacity: at least 1 active staff OR 1 active resource
 *
 * Non-blocking warnings:
 *  - missing logo
 *  - missing home banner / hero
 */
async function validateTenantPublish(db, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) {
    return {
      ok: false,
      errors: [{ code: "invalid_tenant_id", message: "Invalid tenantId." }],
      warnings: [],
      checks: {},
      metrics: {},
    };
  }

  const tenantRes = await db.query(
    `SELECT id, slug, name, timezone, logo_url, banner_home_url, branding
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tid]
  );
  const tenant = tenantRes.rows?.[0] || null;
  if (!tenant) {
    return {
      ok: false,
      errors: [{ code: "tenant_not_found", message: "Tenant not found." }],
      warnings: [],
      checks: {},
      metrics: {},
    };
  }

  const errors = [];
  const warnings = [];

  const hasName = nonEmptyString(tenant.name);
  const hasTimezone = nonEmptyString(tenant.timezone);

  if (!hasName) {
    errors.push({
      code: "missing_business_name",
      message: "Business name is required.",
      field: "tenants.name",
    });
  }
  if (!hasTimezone) {
    errors.push({
      code: "missing_timezone",
      message: "Timezone is required.",
      field: "tenants.timezone",
    });
  }

  const hoursRes = await db.query(
    `
    SELECT COUNT(*)::int AS open_days
    FROM tenant_hours
    WHERE tenant_id = $1
      AND COALESCE(is_closed, FALSE) = FALSE
      AND open_time IS NOT NULL
      AND close_time IS NOT NULL
      -- allow same-day and overnight hours (e.g. 10:00 -> 00:00 or 18:00 -> 02:00)
      AND (
        open_time < close_time
        OR close_time = '00:00'::time
        OR open_time > close_time
        OR open_time = close_time
      )
    `,
    [tid]
  );
  const openDays = countRows(hoursRes.rows?.[0]?.open_days);
  if (openDays <= 0) {
    errors.push({
      code: "missing_business_hours",
      message: "At least one open day with valid hours is required.",
      field: "tenant_hours",
    });
  }

  const servicesRes = await db.query(
    `
    SELECT COUNT(*)::int AS active_services
    FROM services
    WHERE tenant_id = $1
      AND COALESCE(is_active, TRUE) = TRUE
    `,
    [tid]
  );
  const activeServices = countRows(servicesRes.rows?.[0]?.active_services);
  if (activeServices <= 0) {
    errors.push({
      code: "missing_services",
      message: "At least one active service is required.",
      field: "services",
    });
  }

  const staffRes = await db.query(
    `
    SELECT COUNT(*)::int AS active_staff
    FROM staff
    WHERE tenant_id = $1
      AND COALESCE(is_active, TRUE) = TRUE
    `,
    [tid]
  );
  const activeStaff = countRows(staffRes.rows?.[0]?.active_staff);

  const resourcesRes = await db.query(
    `
    SELECT COUNT(*)::int AS active_resources
    FROM resources
    WHERE tenant_id = $1
      AND COALESCE(is_active, TRUE) = TRUE
    `,
    [tid]
  );
  const activeResources = countRows(resourcesRes.rows?.[0]?.active_resources);

  const hasCapacity = activeStaff > 0 || activeResources > 0;
  if (!hasCapacity) {
    errors.push({
      code: "missing_capacity",
      message: "At least one active staff member or one active resource is required.",
      field: "staff/resources",
    });
  }

  // ---------- Non-blocking warnings (quality) ----------
  const branding = tenant.branding && typeof tenant.branding === "object" ? tenant.branding : {};
  const assetsLogo = branding?.assets?.logoUrl || branding?.assets?.logo_url || null;
  const hasLogo = nonEmptyString(tenant.logo_url) || nonEmptyString(assetsLogo);
  if (!hasLogo) {
    warnings.push({
      code: "missing_logo",
      message: "Logo is not set. Booking page will look unfinished.",
      field: "tenants.logo_url",
    });
  }

  const homeBanner = tenant.banner_home_url || branding?.assets?.banners?.home || null;
  if (!nonEmptyString(homeBanner)) {
    warnings.push({
      code: "missing_home_banner",
      message: "Home banner (hero image) is not set.",
      field: "tenants.banner_home_url",
    });
  }

  const ok = errors.length === 0;

  return {
    ok,
    errors,
    warnings,
    checks: {
      business: hasName && hasTimezone,
      hours: openDays > 0,
      services: activeServices > 0,
      capacity: hasCapacity,
    },
    metrics: {
      openDays,
      activeServices,
      activeStaff,
      activeResources,
    },
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      timezone: tenant.timezone,
    },
  };
}

module.exports = {
  validateTenantPublish,
};
