// utils/dashboardSummary/context.js
//
// Shared context builder for dashboardSummary sections.
//
// All section helpers depend on the same upfront-computed values:
//   - tenant ID, slug
//   - mode (day/week/month) + date + range
//   - which bookings start column to use (compat across schema variants)
//   - whether money columns are available
//   - currency, thresholds, target goals
//   - capacity counts (resources, staff)
//
// Computing these once and passing as a single ctx object lets each
// section helper take a single param. This replaces the original
// monolithic getDashboardSummary, which kept 20+ locals in scope across
// 1200+ lines.

const db = require("../../db");
const { ensureBookingMoneyColumns } = require("../ensureBookingMoneyColumns");
const {
  pickCol,
  parseISODateOnly,
  computeRange,
  countTableRows,
  resolveTenantCurrencyCode,
  resolveDashboardThresholds,
  resolveDashboardTargets,
} = require("../dashboardHelpers");

/**
 * Build the shared context. Must be called once at the top of
 * getDashboardSummary. All async setup happens here so section helpers
 * can stay synchronous-looking around their own queries.
 *
 * @param {object} input
 * @param {number|string} input.tenantId
 * @param {string} input.tenantSlug
 * @param {'day'|'week'|'month'} input.mode
 * @param {string} input.dateStr  ISO date YYYY-MM-DD
 * @param {number|null} input.staffId  optional staff scope
 */
async function buildContext({ tenantId, tenantSlug, mode, dateStr, staffId = null }) {
  const hasMoneyCols = await ensureBookingMoneyColumns();

  // bookings start column compatibility (start_time vs start_at vs start_datetime...)
  const startCol = await pickCol("bookings", "b", [
    "start_time",
    "start_at",
    "start_datetime",
    "starts_at",
    "start",
  ]);
  if (!startCol) {
    throw new Error(
      "Dashboard summary cannot run: bookings table has no recognized start time column (expected one of start_time/start_at/start_datetime/starts_at)."
    );
  }

  const safeMode = mode === "week" || mode === "month" ? mode : "day";
  // Staff scope: only show their own data when staffId is provided
  const staffClause = (staffId && Number.isFinite(Number(staffId))) ? `AND b.staff_id = ${Number(staffId)}` : "";
  const safeDate = parseISODateOnly(dateStr) || new Date().toISOString().slice(0, 10);

  const { rangeStart, rangeEnd } = computeRange(safeMode, safeDate);
  const truncUnit = safeMode === "day" ? "hour" : "day";

  // Revenue SELECT fragment used by multiple section helpers
  const revenueSelect = hasMoneyCols
    ? "COALESCE(SUM(charge_amount) FILTER (WHERE status='confirmed'), 0)::numeric AS revenue_amount,"
    : "0::numeric AS revenue_amount,";

  const [currencyCode, thresholds, targetGoals, resourceCount, staffCount] = await Promise.all([
    resolveTenantCurrencyCode(tenantId),
    resolveDashboardThresholds(tenantId),
    resolveDashboardTargets(tenantId, safeMode),
    countTableRows("resources", tenantId),
    countTableRows("staff", tenantId),
  ]);

  const capacityUnits = resourceCount > 0 ? resourceCount : staffCount;

  return {
    db,
    // identity
    tenantId,
    tenantSlug,
    // range
    mode: safeMode,
    safeDate,
    rangeStart,
    rangeEnd,
    truncUnit,
    // schema flags
    hasMoneyCols,
    startCol,
    // staff scope
    staffClause,
    staffId,
    // SQL fragments
    revenueSelect,
    // resolved tenant config
    currencyCode,
    thresholds,
    targetGoals,
    // capacity
    resourceCount,
    staffCount,
    capacityUnits,
  };
}

module.exports = { buildContext };
