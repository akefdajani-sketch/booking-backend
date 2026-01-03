// routes/availability.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// ---------------- helpers ----------------
function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseYMD(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  return new Date(Date.UTC(y, mo - 1, da, 0, 0, 0, 0));
}

function minutesSinceMidnight(timeStr) {
  if (!timeStr) return null;
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeStr);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh * 60 + mm;
}

function addMinutesUTC(d, min) {
  return new Date(d.getTime() + min * 60 * 1000);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  // [start, end)
  return aStart < bEnd && bStart < aEnd;
}

function toTimeLabelUTC(d) {
  // "10:15 AM"
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${pad2(mm)} ${ampm}`;
}

// ---------------- route ----------------
//
// GET /api/availability?tenantSlug=&date=YYYY-MM-DD&serviceId=&staffId=&resourceId=
//
// Returns ALL pills (interval segments) with availability flags.
// Service defines interval/min/max.
//
router.get("/", async (req, res) => {
  try {
    const tenantSlug = String(req.query.tenantSlug || req.query.slug || "").trim();
    const dateStr = String(req.query.date || "").trim();

    const serviceIdRaw = req.query.serviceId ?? req.query.service_id;
    const staffIdRaw = req.query.staffId ?? req.query.staff_id;
    const resourceIdRaw = req.query.resourceId ?? req.query.resource_id;

    const serviceId = serviceIdRaw != null && serviceIdRaw !== "" ? Number(serviceIdRaw) : null;
    const staffId = staffIdRaw != null && staffIdRaw !== "" ? Number(staffIdRaw) : null;
    const resourceId = resourceIdRaw != null && resourceIdRaw !== "" ? Number(resourceIdRaw) : null;

    if (!tenantSlug) return res.status(400).json({ error: "tenantSlug is required" });
    if (!dateStr) return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });

    const day = parseYMD(dateStr);
    if (!day) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

    // 1) Resolve tenant
    const t = await pool.query(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [tenantSlug]);
    if (!t.rows.length) return res.status(404).json({ error: "Tenant not found" });
    const tenantId = t.rows[0].id;

    // 2) Load service rules
    if (!serviceId) return res.status(400).json({ error: "serviceId is required" });

    const sRes = await pool.query(
      `
      SELECT
        id,
        tenant_id,
        duration_minutes,
        slot_interval_minutes,
        max_consecutive_slots,
        max_parallel_bookings,
        requires_staff,
        requires_resource
      FROM services
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1
      `,
      [serviceId, tenantId]
    );

    if (!sRes.rows.length) return res.status(404).json({ error: "Service not found" });

    const s = sRes.rows[0];

    const durationMinutes = Number(s.duration_minutes || 60) || 60; // service minimum duration
    const intervalMinutes = Number(s.slot_interval_minutes || 60) || 60; // pill size
    const maxConsecutiveSlots = Number(s.max_consecutive_slots || 0) || Math.max(1, Math.ceil(durationMinutes / intervalMinutes));
    const maxParallelBookings = Number(s.max_parallel_bookings || 1) || 1;

    const requiresStaff = Boolean(s.requires_staff);
    const requiresResource = Boolean(s.requires_resource);

    // enforce requirements (if service says so)
    if (requiresResource && !resourceId) return res.json({ slots: [], rules: { intervalMinutes, minSlots: 0, maxConsecutiveSlots } });
    if (requiresStaff && !staffId) return res.json({ slots: [], rules: { intervalMinutes, minSlots: 0, maxConsecutiveSlots } });

    const minSlots = Math.max(1, Math.ceil(durationMinutes / intervalMinutes));

    // 3) Working hours
    const dow = day.getUTCDay();
    const th = await pool.query(
      `
      SELECT open_time, close_time, is_closed
      FROM tenant_hours
      WHERE tenant_id = $1 AND day_of_week = $2
      LIMIT 1
      `,
      [tenantId, dow]
    );

    if (!th.rows.length) return res.json({ slots: [], rules: { intervalMinutes, minSlots, maxConsecutiveSlots } });

    const { open_time, close_time, is_closed } = th.rows[0];
    if (is_closed) return res.json({ slots: [], rules: { intervalMinutes, minSlots, maxConsecutiveSlots } });

    const openMin = minutesSinceMidnight(open_time);
    const closeMin = minutesSinceMidnight(close_time);
    if (openMin == null || closeMin == null) return res.json({ slots: [], rules: { intervalMinutes, minSlots, maxConsecutiveSlots } });

    // if close <= open => crosses midnight
    const crossesMidnight = closeMin <= openMin;

    const openDT = addMinutesUTC(day, openMin);
    const closeDT = crossesMidnight
      ? addMinutesUTC(addMinutesUTC(day, 24 * 60), closeMin)
      : addMinutesUTC(day, closeMin);

    // 4) Fetch blocking bookings overlapping [openDT, closeDT)
    // We will apply scope: tenant + (resource OR staff if provided) + blocking statuses.
    const blockingStatuses = ["pending", "confirmed"];

    const whereParts = [`b.tenant_id = $1`, `b.status = ANY($2)`];
    const params = [tenantId, blockingStatuses];

    // Optional scope narrowing (matches your UI behavior)
    if (resourceId) {
      params.push(resourceId);
      whereParts.push(`b.resource_id = $${params.length}`);
    } else if (staffId) {
      params.push(staffId);
      whereParts.push(`b.staff_id = $${params.length}`);
    }

    // Bound window
    params.push(openDT.toISOString());
    whereParts.push(`b.start_time < $${params.length}::timestamptz`);
    params.push(closeDT.toISOString());
    whereParts.push(`(b.start_time + (b.duration_minutes::int || ' minutes')::interval) > $${params.length}::timestamptz`);

    const bq = await pool.query(
      `
      SELECT b.start_time, b.duration_minutes
      FROM bookings b
      WHERE ${whereParts.join(" AND ")}
      `,
      params
    );

    const bookings = (bq.rows || [])
      .map((r) => {
        const st = new Date(r.start_time);
        const dur = Number(r.duration_minutes || 0);
        const en = addMinutesUTC(st, dur);
        return { st, en };
      })
      .filter((x) => !Number.isNaN(x.st.getTime()) && !Number.isNaN(x.en.getTime()));

    // Capacity:
    // - If resource selected, assume that single resource capacity = 1 (parallel handled by resources list).
    // - Otherwise allow service-level parallel capacity.
    const capacity = resourceId ? 1 : maxParallelBookings;

    // 5) Generate pills: every interval between open and close
    // Pills represent segments [t, t+interval)
    const slots = [];
    for (let cur = new Date(openDT); cur.getTime() + intervalMinutes * 60 * 1000 <= closeDT.getTime(); cur = addMinutesUTC(cur, intervalMinutes)) {
      const segEnd = addMinutesUTC(cur, intervalMinutes);

      const overlapCount = bookings.reduce((acc, b) => (overlaps(cur, segEnd, b.st, b.en) ? acc + 1 : acc), 0);
      const available = overlapCount < capacity;

      slots.push({
        time: `${pad2(cur.getUTCHours())}:${pad2(cur.getUTCMinutes())}`, // "HH:MM"
        label: toTimeLabelUTC(cur),
        available,
        reason: available ? null : "capacity_full",
        start_time: cur.toISOString(),
      });
    }

    return res.json({
      slots,
      rules: {
        intervalMinutes,
        minSlots,
        maxConsecutiveSlots,
        maxParallelBookings,
      },
    });
  } catch (err) {
    console.error("GET /api/availability error:", err);
    return res.status(500).json({ error: "Failed to load availability." });
  }
});

module.exports = router;
