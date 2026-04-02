// routes/availability.js
// Returns ALL candidate slots for a day, each with is_available/available flags.
// Keeps `times` (available-only) for backward compatibility.
//
// ✅ Works for BOTH public booking (tenantSlug) and owner/manual booking (tenantId).
//
// Slot generation logic lives in utils/availabilityEngine.js.

const express = require("express");
const router  = express.Router();
const pool    = require("../db");
const { buildAvailabilitySlots, normalizeDateInput } = require("../utils/availabilityEngine");

router.get("/", async (req, res) => {
  try {
    const {
      tenantSlug,
      tenantId: tenantIdRaw,
      date: dateRaw,
      serviceId: serviceIdRaw,
      staffId: staffIdRaw,
      resourceId: resourceIdRaw,
    } = req.query;

    const date = normalizeDateInput(dateRaw);

    if ((!tenantSlug && !tenantIdRaw) || !date || !serviceIdRaw) {
      return res.status(400).json({
        error: "Missing required params: (tenantSlug OR tenantId), date, serviceId",
      });
    }

    // Normalise IDs
    const serviceId  = Number(serviceIdRaw);
    const staffId    = staffIdRaw   != null && staffIdRaw   !== "" ? Number(staffIdRaw)   : null;
    const resourceId = resourceIdRaw != null && resourceIdRaw !== "" ? Number(resourceIdRaw) : null;

    // Resolve tenantId + timezone (supports either tenantId or tenantSlug)
    let tenantId = tenantIdRaw != null && tenantIdRaw !== "" ? Number(tenantIdRaw) : null;
    let tenantTz = "UTC";

    if (!tenantId) {
      const row = await pool.query("SELECT id, timezone FROM tenants WHERE slug = $1", [tenantSlug]);
      if (!row.rows.length) return res.status(404).json({ error: "Tenant not found" });
      tenantId = Number(row.rows[0].id);
      tenantTz = row.rows[0].timezone || "UTC";
    }

    // If tenantId was provided directly, still need timezone
    if (tenantTz === "UTC") {
      const tzRow = await pool.query("SELECT timezone FROM tenants WHERE id = $1", [tenantId]);
      tenantTz = tzRow.rows[0]?.timezone || "UTC";
    }

    if (!Number.isFinite(tenantId) || !Number.isFinite(serviceId)) {
      return res.status(400).json({ error: "Invalid tenantId/serviceId" });
    }

    // Fetch service
    const svcResult = await pool.query(
      "SELECT * FROM services WHERE id = $1 AND tenant_id = $2",
      [serviceId, tenantId]
    );
    if (!svcResult.rows.length) return res.status(404).json({ error: "Service not found" });

    // Run engine
    const result = await buildAvailabilitySlots({
      tenantId,
      tenantSlug: tenantSlug ?? null,
      date,
      serviceId,
      staffId,
      resourceId,
      tenantTz,
      service: svcResult.rows[0],
    });

    return res.json({
      tenantId,
      tenantSlug: tenantSlug ?? null,
      date,
      times: result.times,
      slots: result.slots,
      meta:  result.meta,
    });
  } catch (err) {
    console.error("GET /api/availability error:", err);
    return res.status(500).json({
      error:   "Failed to get availability",
      message: err?.message ?? String(err),
    });
  }
});

module.exports = router;
