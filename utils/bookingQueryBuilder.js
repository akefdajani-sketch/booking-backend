// utils/bookingQueryBuilder.js
//
// Shared WHERE-clause builder for booking list and count queries.
// Used by:
//   GET /api/bookings      (list)
//   GET /api/bookings/count (count)
//
// Both routes accept the same filter params — this eliminates the duplicated
// param-parsing + filter-building logic that previously lived inline in each handler.
//
// PR DAY-VIEW-NIGHTLY-1 (Apr 2026):
//   When scope=range with both `from` and `to` bounds, switched the date
//   filter from "starts in range" (b.start_time >= $from AND b.start_time < $to)
//   to "overlaps range" (b.start_time < $to AND b.end_time > $from).
//
//   This is required for the owner Day/Week/Month view to display:
//     - Nightly bookings (which span multiple days; previously only showed
//       on the checkin date because start_time = midnight of checkin_date)
//     - Multi-hour timeslot bookings that cross day boundaries (rare but
//       possible) — now correctly appear on every day they consume.
//
//   Single-day same-hour bookings (the timeslot common case) are returned
//   identically by both formulations — no behavior change.
//
//   Other scopes (upcoming/past/all/latest) and single-bound usages keep
//   the legacy single-bound start_time logic.

/**
 * Parse and validate booking filter params from an Express req.query object.
 * Returns a plain object; throws nothing — callers receive an {error} string
 * they can send as 400 if validation fails.
 *
 * @param {object} query  req.query
 * @returns {{ error?: string, scope, status, serviceId, staffId, resourceId,
 *             customerId, searchQuery, limit, fromTs, toTs,
 *             cursorStartTime, cursorId, cursorCreatedAt }}
 */
function parseBookingListParams(query) {
  const scopeRaw =
    (query.scope ? String(query.scope) : "") ||
    (query.view  ? String(query.view)  : "");
  const scope = (scopeRaw || "upcoming").toLowerCase(); // upcoming|past|range|all|latest

  const status     = query.status     ? String(query.status).trim()     : null;
  const serviceId  = query.serviceId  ? Number(query.serviceId)          : null;
  const staffId    = query.staffId    ? Number(query.staffId)            : null;
  const resourceId = query.resourceId ? Number(query.resourceId)         : null;
  const customerId = query.customerId ? Number(query.customerId)         : null;
  const searchQuery = query.query     ? String(query.query).trim()       : "";

  const limitRaw = query.limit ? Number(query.limit) : 50;
  const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));

  const cursorStartTime  = query.cursorStartTime  ? new Date(String(query.cursorStartTime))  : null;
  const cursorId         = query.cursorId         ? Number(query.cursorId)                    : null;
  const cursorCreatedAt  = query.cursorCreatedAt  ? new Date(String(query.cursorCreatedAt))  : null;

  const fromTs = query.from ? new Date(String(query.from)) : null;
  const toTs   = query.to   ? new Date(String(query.to))   : null;

  // Validate dates
  if (cursorStartTime && Number.isNaN(cursorStartTime.getTime()))
    return { error: "Invalid cursorStartTime." };
  if (cursorCreatedAt && Number.isNaN(cursorCreatedAt.getTime()))
    return { error: "Invalid cursorCreatedAt." };
  if (cursorId != null && (!Number.isFinite(cursorId) || cursorId <= 0))
    return { error: "Invalid cursorId." };
  if (fromTs && Number.isNaN(fromTs.getTime()))
    return { error: "Invalid from." };
  if (toTs && Number.isNaN(toTs.getTime()))
    return { error: "Invalid to." };

  return {
    scope, status, serviceId, staffId, resourceId, customerId,
    searchQuery, limit, fromTs, toTs,
    cursorStartTime, cursorId, cursorCreatedAt,
  };
}

/**
 * Build the parameterised WHERE clause (and ORDER BY / cursor) for the
 * booking list query.  Returns { where, params, orderBy, isLatest }.
 *
 * @param {object} p   Output of parseBookingListParams
 * @param {number} tenantId
 */
function buildBookingListWhere(p, tenantId) {
  const params = [tenantId];
  const where  = ["b.tenant_id = $1", "b.deleted_at IS NULL"]; // PR-19: soft-delete

  // Scope → implicit time filter
  if (p.scope === "upcoming") {
    where.push("b.start_time >= NOW()");
  } else if (p.scope === "past") {
    where.push("b.start_time < NOW()");
  } else if (p.scope === "range" || p.scope === "all" || p.scope === "latest") {
    // no implicit filter — from/to or cursor handles it
  } else {
    where.push("b.start_time >= NOW()"); // safe default
  }

  // ─── DAY-VIEW-NIGHTLY-1: overlap-based range filter ──────────────────────
  // When scope=range with BOTH bounds, use overlap math so multi-day
  // bookings (nightly stays, midnight-spanning timeslot reservations)
  // appear on every day they consume.
  //
  // Formulation:  b.start_time < $to  AND  b.end_time > $from
  //   - timeslot single-day same-hour: identical to legacy filter
  //   - nightly span: now appears on each day in the span
  //   - midnight-spanning timeslot: now appears on both days
  //
  // Other shapes (single bound, no bounds, cursor) keep legacy behavior.
  if (p.scope === "range" && p.fromTs && p.toTs) {
    params.push(p.fromTs.toISOString());
    const fromIdx = params.length;
    params.push(p.toTs.toISOString());
    const toIdx = params.length;
    where.push(`b.start_time < $${toIdx} AND b.end_time > $${fromIdx}`);
  } else {
    if (p.fromTs) {
      params.push(p.fromTs.toISOString());
      where.push(`b.start_time >= $${params.length}`);
    }
    if (p.toTs) {
      params.push(p.toTs.toISOString());
      where.push(`b.start_time < $${params.length}`);
    }
  }

  if (p.status && p.status !== "all") {
    params.push(p.status);
    where.push(`b.status = $${params.length}`);
  }
  if (Number.isFinite(p.serviceId)  && p.serviceId  > 0) { params.push(p.serviceId);  where.push(`b.service_id  = $${params.length}`); }
  if (Number.isFinite(p.staffId)    && p.staffId    > 0) { params.push(p.staffId);    where.push(`b.staff_id    = $${params.length}`); }
  if (Number.isFinite(p.resourceId) && p.resourceId > 0) { params.push(p.resourceId); where.push(`b.resource_id = $${params.length}`); }
  if (Number.isFinite(p.customerId) && p.customerId > 0) { params.push(p.customerId); where.push(`b.customer_id = $${params.length}`); }

  if (p.searchQuery) {
    params.push(`%${p.searchQuery}%`);
    const ph = `$${params.length}`;
    where.push(
      `(b.booking_code ILIKE ${ph} OR b.customer_name ILIKE ${ph} OR b.customer_phone ILIKE ${ph}` +
      ` OR b.customer_email ILIKE ${ph} OR c.name ILIKE ${ph} OR c.phone ILIKE ${ph} OR c.email ILIKE ${ph})`
    );
  }

  // Keyset cursor + order
  const isLatest  = p.scope === "latest";
  const isPast    = p.scope === "past";
  const orderDir  = (isPast || isLatest) ? "DESC" : "ASC";
  const comparator = (isPast || isLatest) ? "<"   : ">";

  if (isLatest) {
    if (p.cursorCreatedAt && p.cursorId) {
      params.push(p.cursorCreatedAt.toISOString());
      const pC = `$${params.length}`;
      params.push(p.cursorId);
      const pI = `$${params.length}`;
      where.push(`(b.created_at, b.id) ${comparator} (${pC}, ${pI})`);
    }
  } else {
    if (p.cursorStartTime && p.cursorId) {
      params.push(p.cursorStartTime.toISOString());
      const pS = `$${params.length}`;
      params.push(p.cursorId);
      const pI = `$${params.length}`;
      where.push(`(b.start_time, b.id) ${comparator} (${pS}, ${pI})`);
    }
  }

  const orderBy = isLatest
    ? `b.created_at ${orderDir}, b.id ${orderDir}`
    : `b.start_time ${orderDir}, b.id ${orderDir}`;

  return { where, params, orderBy, isLatest };
}

module.exports = { parseBookingListParams, buildBookingListWhere };
