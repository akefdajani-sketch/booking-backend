// utils/dashboardSummary.js
// Shared dashboard summary logic used by:
//  - routes/tenantDashboard.js (tenant-scoped auth)
//  - routes/tenants.js (admin-scoped auth)
//
// IMPORTANT:
// - Tenant isolation: EVERY query must be scoped by tenant_id.
// - Revenue is derived from bookings.charge_amount (stored at booking creation).

const db = require("../db");
const { ensureBookingMoneyColumns, bookingMoneyColsAvailable } = require("./ensureBookingMoneyColumns");

function parseISODateOnly(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function startOfDayUTC(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function addDays(d, days) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function startOfWeekMondayUTC(day) {
  const x = new Date(day.getTime());
  const dow = x.getUTCDay(); // 0=Sun..6=Sat
  const mondayDelta = (dow + 6) % 7; // days since Monday
  return addDays(x, -mondayDelta);
}

function startOfMonthUTC(day) {
  const x = new Date(day.getTime());
  x.setUTCDate(1);
  return x;
}

async function countTableRows(table, tenantId) {
  const reg = await db.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
  if (!reg.rows?.[0]?.reg) return 0;
  const r = await db.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE tenant_id=$1`, [tenantId]);
  return r.rows?.[0]?.c || 0;
}

async function resolveTenantCurrencyCode(tenantId) {
  const hasCurrency = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tenants' AND column_name='currency_code' LIMIT 1`
  );
  if (hasCurrency.rowCount <= 0) return null;
  const tc = await db.query(`SELECT currency_code FROM tenants WHERE id=$1 LIMIT 1`, [tenantId]);
  return tc.rows?.[0]?.currency_code || null;
}

function computeRange(mode, dateStr) {
  const anchorDay = startOfDayUTC(dateStr);
  let rangeStart = anchorDay;
  let rangeEnd = addDays(anchorDay, 1);
  if (mode === "week") {
    rangeStart = startOfWeekMondayUTC(anchorDay);
    rangeEnd = addDays(rangeStart, 7);
  } else if (mode === "month") {
    rangeStart = startOfMonthUTC(anchorDay);
    const nextMonth = new Date(rangeStart.getTime());
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    rangeEnd = nextMonth;
  }
  return { rangeStart, rangeEnd };
}

async function getDashboardSummary({ tenantId, tenantSlug, mode, dateStr }) {
  const hasMoneyCols = await ensureBookingMoneyColumns();

  const safeMode = mode === "week" || mode === "month" ? mode : "day";
  const safeDate = parseISODateOnly(dateStr) || new Date().toISOString().slice(0, 10);

  const { rangeStart, rangeEnd } = computeRange(safeMode, safeDate);

  const revenueSelect = hasMoneyCols ? "COALESCE(SUM(charge_amount) FILTER (WHERE status='confirmed'), 0)::numeric AS revenue_amount," : "0::numeric AS revenue_amount,";

  const kpi = await db.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_count,
      ${revenueSelect}
      COALESCE(SUM(duration_minutes) FILTER (WHERE status='confirmed'), 0)::int AS booked_minutes
    FROM bookings
    WHERE tenant_id=$1
      AND start_time >= $2
      AND start_time < $3
    `,
    [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
  );

  const confirmedCount = kpi.rows?.[0]?.confirmed_count || 0;
  const pendingCount = kpi.rows?.[0]?.pending_count || 0;
  const cancelledCount = kpi.rows?.[0]?.cancelled_count || 0;
  const bookedMinutes = kpi.rows?.[0]?.booked_minutes || 0;
  const revenueAmount = kpi.rows?.[0]?.revenue_amount != null ? String(kpi.rows[0].revenue_amount) : "0";

  const currencyCode = await resolveTenantCurrencyCode(tenantId);

  const next = await db.query(
    `
    SELECT b.id,
           b.start_time,
           COALESCE(b.customer_name,'') AS customer_name,
           COALESCE(s.name,'') AS service_name,
           b.status
    FROM bookings b
    LEFT JOIN services s ON s.id=b.service_id
    WHERE b.tenant_id=$1
      AND b.start_time >= NOW()
      AND b.status IN ('confirmed','pending')
    ORDER BY b.start_time ASC
    LIMIT 5
    `,
    [tenantId]
  );

  const pulse = await db.query(
    `
    WITH in_range AS (
      SELECT DISTINCT customer_id
      FROM bookings
      WHERE tenant_id=$1 AND start_time >= $2 AND start_time < $3 AND customer_id IS NOT NULL
    ), totals AS (
      SELECT customer_id, COUNT(*)::int AS total_bookings
      FROM bookings
      WHERE tenant_id=$1 AND customer_id IS NOT NULL
      GROUP BY customer_id
    )
    SELECT
      COALESCE(SUM(CASE WHEN t.total_bookings = 1 THEN 1 ELSE 0 END),0)::int AS new_customers,
      COALESCE(SUM(CASE WHEN t.total_bookings >= 2 THEN 1 ELSE 0 END),0)::int AS returning_customers,
      COALESCE(COUNT(*),0)::int AS active_customers
    FROM in_range r
    JOIN totals t ON t.customer_id = r.customer_id
    `,
    [tenantId, rangeStart.toISOString(), rangeEnd.toISOString()]
  );

  const activeCustomers = pulse.rows?.[0]?.active_customers || 0;
  const returningCustomers = pulse.rows?.[0]?.returning_customers || 0;
  const repeatPct = activeCustomers > 0 ? Math.round((returningCustomers / activeCustomers) * 100) : 0;

  // Active memberships (best-effort; table might not exist in older envs)
  let activeMemberships = 0;
  const memReg = await db.query(`SELECT to_regclass('public.customer_memberships') AS reg`);
  if (memReg.rows?.[0]?.reg) {
    const m = await db.query(
      `
      SELECT COUNT(*)::int AS c
      FROM customer_memberships
      WHERE tenant_id=$1
        AND status='active'
        AND (end_at IS NULL OR end_at > NOW())
      `,
      [tenantId]
    );
    activeMemberships = m.rows?.[0]?.c || 0;
  }

  // Utilization: resources first, then staff
  const resourceCount = await countTableRows("resources", tenantId);
  const staffCount = await countTableRows("staff", tenantId);
  const capacityUnits = resourceCount > 0 ? resourceCount : staffCount;

  let utilizationPct = null;
  const hoursReg = await db.query(`SELECT to_regclass('public.tenant_hours') AS reg`);
  if (hoursReg.rows?.[0]?.reg && capacityUnits > 0) {
    const hours = await db.query(
      `SELECT day_of_week, start_time, end_time
       FROM tenant_hours
       WHERE tenant_id=$1`,
      [tenantId]
    );

    const rows = hours.rows || [];
    let openMinutes = 0;

    const cursor = new Date(rangeStart.getTime());
    while (cursor.getTime() < rangeEnd.getTime()) {
      const dow = cursor.getUTCDay();
      const todays = rows.filter((r) => Number(r.day_of_week) === dow);
      for (const r of todays) {
        const st = String(r.start_time || "").slice(0, 5);
        const et = String(r.end_time || "").slice(0, 5);
        if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) continue;
        const [sh, sm] = st.split(":").map(Number);
        const [eh, em] = et.split(":").map(Number);
        const mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins > 0) openMinutes += mins;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const capacityMinutes = openMinutes * capacityUnits;
    if (capacityMinutes > 0) utilizationPct = Math.round((bookedMinutes / capacityMinutes) * 100);
  }

  const nextBookings = (next.rows || []).map((r) => {
    const status = String(r.status || "").toLowerCase();
    return {
      id: String(r.id),
      start_time: r.start_time,
      customer_name: String(r.customer_name || "").trim() || "Customer",
      service_name: String(r.service_name || "").trim() || "Service",
      status: status === "pending" ? "pending" : status === "cancelled" ? "cancelled" : "confirmed",
    };
  });

  const attention = [];
  if (pendingCount > 0) {
    attention.push({ title: "Pending bookings", value: `${pendingCount} need confirmation`, tone: "warn" });
  }
  if (utilizationPct != null && utilizationPct < 20) {
    attention.push({ title: "Underused capacity", value: "Utilization under 20%", tone: "neutral" });
  }

  return {
    ok: true,
    tenantId,
    tenantSlug,
    range: {
      mode: safeMode,
      date: safeDate,
      from: rangeStart.toISOString(),
      to: rangeEnd.toISOString(),
    },
    currency_code: currencyCode,
    kpis: {
      bookings: confirmedCount,
      pending: pendingCount,
      cancelled: cancelledCount,
      revenue_amount: revenueAmount,
      utilizationPct,
      repeatPct,
      activeMemberships,
    },
    panels: {
      nextBookings,
      attention,
      customerPulse: { activeCustomers, returningCustomers },
    },
  };
}

module.exports = { getDashboardSummary, parseISODateOnly };
