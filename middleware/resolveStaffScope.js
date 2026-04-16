// middleware/resolveStaffScope.js
//
// Attaches req.staffId when the logged-in user is a STAFF role member
// with a linked staff record for this tenant.
//
// This enables data-scoping: bookings, dashboard KPIs, and schedule
// routes can filter by req.staffId to show only the staff member's own data.
//
// Usage (add after requireTenantRole):
//   router.get("/...", requireAppAuth, ensureUser, requireTenant,
//              requireTenantRole("viewer"), resolveStaffScope, handler)
//
// Sets:
//   req.staffId       — number | null  (null if owner/manager or no linked staff)
//   req.isStaffScoped — boolean        (true if data should be filtered to staffId)

"use strict";

const db = require("../db");

async function resolveStaffScope(req, _res, next) {
  try {
    // Only scope for STAFF role (not owner, manager, viewer)
    if (req.tenantRole !== "staff") {
      req.staffId = null;
      req.isStaffScoped = false;
      return next();
    }

    const tenantId = Number(req.tenantId);
    const userId = Number(req.user?.id);

    if (!tenantId || !userId) {
      req.staffId = null;
      req.isStaffScoped = false;
      return next();
    }

    // Look up their linked staff record
    const r = await db.query(
      `SELECT id FROM staff WHERE tenant_id = $1 AND user_id = $2 AND is_active = true LIMIT 1`,
      [tenantId, userId]
    );

    if (r.rows.length) {
      req.staffId = Number(r.rows[0].id);
      req.isStaffScoped = true;
    } else {
      // Staff role but no linked staff record yet — allow read but no data
      req.staffId = null;
      req.isStaffScoped = true; // still scoped — they should see nothing until linked
    }

    return next();
  } catch (err) {
    console.error("resolveStaffScope error:", err);
    req.staffId = null;
    req.isStaffScoped = false;
    return next();
  }
}

module.exports = resolveStaffScope;
