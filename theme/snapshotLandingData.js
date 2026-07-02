'use strict';

// theme/snapshotLandingData.js
//
// Builds the `landingData` block that resolveTenantAppearanceSnapshot bakes into
// tenants.appearance_snapshot_published_json. The public /book/[slug] page reads
// this block on first render so services + specialists appear instantly instead
// of after a post-hydration client fetch.
//
// SECURITY: These two queries MUST mirror the existing PUBLIC endpoints exactly
// (field lists, visibility filters, ORDER BY, per-row tenants.currency_code
// source). The snapshot is served to the public page; adding a field here that
// isn't already public would leak it.
//
//   services → GET /api/services   (routes/services/crud.js:22-239)
//   staff    → GET /api/staff      (routes/staff.js:75-133)

const db = require('../db');
const {
  getServicesColumns,
  getTenantsColumns,
  serviceHoursTableExists,
} = require('../utils/servicesHelpers');

async function buildServicesList(tenantId) {
  const svcCols = await getServicesColumns();
  const tenantCols = await getTenantsColumns();
  const hasServiceHours = await serviceHoursTableExists();

  const priceExpr =
    svcCols.has('price_amount') && svcCols.has('price')
      ? 'COALESCE(s.price_amount, s.price) AS price_amount'
      : svcCols.has('price_amount')
      ? 's.price_amount AS price_amount'
      : svcCols.has('price')
      ? 's.price AS price_amount'
      : 'NULL::numeric AS price_amount';

  const maxParallelExpr =
    svcCols.has('max_parallel_bookings') && svcCols.has('max_parallel')
      ? 'COALESCE(s.max_parallel_bookings, s.max_parallel) AS max_parallel_bookings'
      : svcCols.has('max_parallel_bookings')
      ? 's.max_parallel_bookings AS max_parallel_bookings'
      : svcCols.has('max_parallel')
      ? 's.max_parallel AS max_parallel_bookings'
      : 'NULL::int AS max_parallel_bookings';

  const slotIntervalExpr = svcCols.has('slot_interval_minutes')
    ? 's.slot_interval_minutes AS slot_interval_minutes'
    : 'NULL::int AS slot_interval_minutes';

  const maxConsecutiveExpr = svcCols.has('max_consecutive_slots')
    ? 's.max_consecutive_slots AS max_consecutive_slots'
    : 'NULL::int AS max_consecutive_slots';

  const minConsecutiveExpr = svcCols.has('min_consecutive_slots')
    ? 's.min_consecutive_slots AS min_consecutive_slots'
    : 'NULL::int AS min_consecutive_slots';

  const imageExpr =
    svcCols.has('image_url') && svcCols.has('photo_url')
      ? 'COALESCE(s.image_url, s.photo_url) AS image_url'
      : svcCols.has('image_url')
      ? 's.image_url AS image_url'
      : svcCols.has('photo_url')
      ? 's.photo_url AS image_url'
      : 'NULL::text AS image_url';

  const currencyExpr = tenantCols.has('currency_code')
    ? 't.currency_code AS currency_code'
    : 'NULL::text AS currency_code';

  const requiresConfirmationExpr = svcCols.has('requires_confirmation')
    ? 'COALESCE(s.requires_confirmation, false) AS requires_confirmation'
    : 'false::boolean AS requires_confirmation';

  const allowMembershipExpr = svcCols.has('allow_membership')
    ? 'COALESCE(s.allow_membership, false) AS allow_membership'
    : 'false::boolean AS allow_membership';

  const bookingModeExpr = svcCols.has('booking_mode')
    ? "COALESCE(s.booking_mode, 'time_slots') AS booking_mode"
    : "'time_slots'::text AS booking_mode";
  const minNightsExpr = svcCols.has('min_nights')
    ? 'COALESCE(s.min_nights, 1) AS min_nights'
    : '1::int AS min_nights';
  const maxNightsExpr = svcCols.has('max_nights')
    ? 's.max_nights AS max_nights'
    : 'NULL::int AS max_nights';
  const checkinTimeExpr = svcCols.has('checkin_time')
    ? "COALESCE(s.checkin_time::text, '15:00') AS checkin_time"
    : "'15:00'::text AS checkin_time";
  const checkoutTimeExpr = svcCols.has('checkout_time')
    ? "COALESCE(s.checkout_time::text, '11:00') AS checkout_time"
    : "'11:00'::text AS checkout_time";
  const pricePerNightExpr = svcCols.has('price_per_night')
    ? 's.price_per_night AS price_per_night'
    : 'NULL::numeric AS price_per_night';

  const vatRateExpr = svcCols.has('vat_rate')
    ? 's.vat_rate AS vat_rate'
    : 'NULL::numeric AS vat_rate';
  const vatLabelExpr = svcCols.has('vat_label')
    ? 's.vat_label AS vat_label'
    : 'NULL::text AS vat_label';
  const svcChargeRateExpr = svcCols.has('service_charge_rate')
    ? 's.service_charge_rate AS service_charge_rate'
    : 'NULL::numeric AS service_charge_rate';

  const softDeleteAnd = svcCols.has('deleted_at') ? ' AND s.deleted_at IS NULL' : '';

  const q = `
    SELECT
      s.id,
      s.tenant_id,
      s.name,
      s.description,
      s.duration_minutes,
      ${priceExpr},
      ${slotIntervalExpr},
      ${minConsecutiveExpr},
      ${maxConsecutiveExpr},
      ${maxParallelExpr},
      COALESCE(s.requires_staff, false)    AS requires_staff,
      COALESCE(s.requires_resource, false) AS requires_resource,
      ${requiresConfirmationExpr},
      ${allowMembershipExpr},
      s.availability_basis                AS availability_basis,
      COALESCE(s.is_active, true)         AS is_active,
      s.archived_at                       AS archived_at,
      s.archived_by                       AS archived_by,
      ${imageExpr},
      ${currencyExpr},
      s.category_id,
      ${bookingModeExpr},
      ${minNightsExpr},
      ${maxNightsExpr},
      ${checkinTimeExpr},
      ${checkoutTimeExpr},
      ${pricePerNightExpr},
      ${vatRateExpr},
      ${vatLabelExpr},
      ${svcChargeRateExpr}
    FROM services s
    JOIN tenants t ON t.id = s.tenant_id
    WHERE s.tenant_id = $1
      AND COALESCE(s.is_active, true) = true
      AND s.archived_at IS NULL${softDeleteAnd}
    ORDER BY s.id DESC
  `;

  const { rows } = await db.query(q, [tenantId]);

  if (hasServiceHours && rows.length > 0) {
    const serviceIds = rows.map((r) => r.id);
    const { rows: hoursRows } = await db.query(
      `SELECT service_id, day_of_week, open_time::text AS open_time, close_time::text AS close_time
       FROM service_hours
       WHERE service_id = ANY($1)
       ORDER BY service_id, day_of_week`,
      [serviceIds]
    );
    const hoursMap = {};
    for (const h of hoursRows) {
      if (!hoursMap[h.service_id]) hoursMap[h.service_id] = [];
      hoursMap[h.service_id].push({
        day_of_week: h.day_of_week,
        open_time: h.open_time,
        close_time: h.close_time,
      });
    }
    for (const row of rows) {
      row.available_hours = hoursMap[row.id] || [];
    }
  } else {
    for (const row of rows) {
      row.available_hours = [];
    }
  }

  return rows;
}

async function buildStaffList(tenantId) {
  const q = `
    SELECT
      st.*,
      t.slug AS tenant_slug,
      COALESCE(
        (SELECT ARRAY_AGG(ssl.service_id ORDER BY ssl.service_id)
         FROM staff_service_links ssl
         WHERE ssl.tenant_id = st.tenant_id
           AND ssl.staff_id  = st.id),
        ARRAY[]::int[]
      ) AS service_ids,
      (SELECT s.name
       FROM staff_service_links ssl2
       JOIN services s ON s.id = ssl2.service_id
       WHERE ssl2.tenant_id = st.tenant_id
         AND ssl2.staff_id  = st.id
       ORDER BY ssl2.service_id
       LIMIT 1) AS primary_service_name
    FROM staff st
    JOIN tenants t ON t.id = st.tenant_id
    WHERE st.tenant_id = $1
      AND st.is_active = true
      AND st.archived_at IS NULL
    ORDER BY st.created_at DESC
  `;
  const { rows } = await db.query(q, [tenantId]);
  return rows;
}

async function buildLandingData(tenantId) {
  const [services, staff] = await Promise.all([
    buildServicesList(tenantId),
    buildStaffList(tenantId),
  ]);
  return { services, staff };
}

module.exports = { buildLandingData };
