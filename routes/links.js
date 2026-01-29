// routes/links.js
// Phase 3: relationship linking between staff/resources and services.
//
// Public endpoints are used by booking UI to filter selections.
// Admin endpoints are used by owner dashboard to manage links.

const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const { ensureLinksSchema } = require("../utils/ensureLinksSchema");

let schemaEnsured = false;
async function ensureOnce() {
  if (schemaEnsured) return;
  await ensureLinksSchema();
  schemaEnsured = true;
}

async function resolveTenantId({ tenantId, tenantSlug }) {
  if (tenantId) return Number(tenantId);
  if (!tenantSlug) return null;
  const r = await db.query("SELECT id FROM tenants WHERE slug = $1 LIMIT 1", [
    String(tenantSlug),
  ]);
  return r.rows?.[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/links/service?tenantSlug=&serviceId=
// Public: returns allowed staff/resource IDs for a given service.
// Behavior is "safe by default": if no links exist, returns mode="all".
// ---------------------------------------------------------------------------
router.get("/service", async (req, res) => {
  try {
    await ensureOnce();

    const { tenantSlug, tenantId, serviceId } = req.query;
    const sid = Number(serviceId);
    if (!Number.isFinite(sid) || sid <= 0) {
      return res.status(400).json({ error: "serviceId is required" });
    }

    const tid = await resolveTenantId({ tenantId, tenantSlug });
    if (!tid) return res.status(404).json({ error: "Tenant not found" });

    // Confirm service belongs to tenant (prevents cross-tenant inference)
    const svc = await db.query(
      "SELECT id FROM services WHERE id = $1 AND tenant_id = $2 LIMIT 1",
      [sid, tid]
    );
    if (!svc.rows.length) return res.status(404).json({ error: "Service not found" });

    const staffLinks = await db.query(
      "SELECT staff_id FROM staff_service_links WHERE tenant_id = $1 AND service_id = $2",
      [tid, sid]
    );
    const resourceLinks = await db.query(
      "SELECT resource_id FROM resource_service_links WHERE tenant_id = $1 AND service_id = $2",
      [tid, sid]
    );

    const staffIds = staffLinks.rows.map((r) => r.staff_id);
    const resourceIds = resourceLinks.rows.map((r) => r.resource_id);

    return res.json({
      tenant_id: tid,
      service_id: sid,
      staff: staffIds.length ? { mode: "linked", ids: staffIds } : { mode: "all", ids: [] },
      resources: resourceIds.length
        ? { mode: "linked", ids: resourceIds }
        : { mode: "all", ids: [] },
    });
  } catch (err) {
    console.error("GET /api/links/service error:", err);
    return res.status(500).json({ error: "Failed to load service links" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/links/tenant?tenantSlug=&tenantId=
// Admin: returns the full mapping for a tenant.
// ---------------------------------------------------------------------------
router.get("/tenant", requireAdmin, async (req, res) => {
  try {
    await ensureOnce();
    const { tenantSlug, tenantId } = req.query;
    const tid = await resolveTenantId({ tenantId, tenantSlug });
    if (!tid) return res.status(404).json({ error: "Tenant not found" });

    const staffSvc = await db.query(
      "SELECT staff_id, service_id FROM staff_service_links WHERE tenant_id = $1",
      [tid]
    );
    const resSvc = await db.query(
      "SELECT resource_id, service_id FROM resource_service_links WHERE tenant_id = $1",
      [tid]
    );

    return res.json({
      tenant_id: tid,
      staff_services: staffSvc.rows,
      resource_services: resSvc.rows,
    });
  } catch (err) {
    console.error("GET /api/links/tenant error:", err);
    return res.status(500).json({ error: "Failed to load tenant links" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/links/staff/:id/services
// Admin: replace the services linked to a staff member.
// Body: { service_ids: number[] }
// ---------------------------------------------------------------------------
router.post("/staff/:id/services", requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await ensureOnce();

    const staffId = Number(req.params.id);
    const serviceIds = Array.isArray(req.body?.service_ids) ? req.body.service_ids : [];

    if (!Number.isFinite(staffId) || staffId <= 0) {
      return res.status(400).json({ error: "Invalid staff id" });
    }

    const staffRow = await db.query("SELECT id, tenant_id FROM staff WHERE id = $1", [
      staffId,
    ]);
    const staff = staffRow.rows?.[0];
    if (!staff) return res.status(404).json({ error: "Staff not found" });

    const tid = staff.tenant_id;

    await client.query("BEGIN");
    await client.query(
      "DELETE FROM staff_service_links WHERE tenant_id = $1 AND staff_id = $2",
      [tid, staffId]
    );

    if (serviceIds.length) {
      // Insert only services that belong to the same tenant.
      await client.query(
        `
          INSERT INTO staff_service_links (tenant_id, staff_id, service_id)
          SELECT $1, $2, s.id
          FROM services s
          WHERE s.tenant_id = $1 AND s.id = ANY($3::int[])
        `,
        [tid, staffId, serviceIds.map((x) => Number(x)).filter((x) => Number.isFinite(x))]
      );
    }

    await client.query("COMMIT");

    const out = await db.query(
      "SELECT staff_id, service_id FROM staff_service_links WHERE tenant_id = $1 AND staff_id = $2 ORDER BY service_id",
      [tid, staffId]
    );
    return res.json({ ok: true, staff_id: staffId, tenant_id: tid, links: out.rows });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /api/links/staff/:id/services error:", err);
    return res.status(500).json({ error: "Failed to update staff links" });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/links/resource/:id/services
// Admin: replace the services linked to a resource.
// Body: { service_ids: number[] }
// ---------------------------------------------------------------------------
router.post("/resource/:id/services", requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await ensureOnce();

    const resourceId = Number(req.params.id);
    const serviceIds = Array.isArray(req.body?.service_ids) ? req.body.service_ids : [];

    if (!Number.isFinite(resourceId) || resourceId <= 0) {
      return res.status(400).json({ error: "Invalid resource id" });
    }

    const resourceRow = await db.query(
      "SELECT id, tenant_id FROM resources WHERE id = $1",
      [resourceId]
    );
    const resource = resourceRow.rows?.[0];
    if (!resource) return res.status(404).json({ error: "Resource not found" });

    const tid = resource.tenant_id;

    await client.query("BEGIN");
    await client.query(
      "DELETE FROM resource_service_links WHERE tenant_id = $1 AND resource_id = $2",
      [tid, resourceId]
    );

    if (serviceIds.length) {
      await client.query(
        `
          INSERT INTO resource_service_links (tenant_id, resource_id, service_id)
          SELECT $1, $2, s.id
          FROM services s
          WHERE s.tenant_id = $1 AND s.id = ANY($3::int[])
        `,
        [tid, resourceId, serviceIds.map((x) => Number(x)).filter((x) => Number.isFinite(x))]
      );
    }

    await client.query("COMMIT");

    const out = await db.query(
      "SELECT resource_id, service_id FROM resource_service_links WHERE tenant_id = $1 AND resource_id = $2 ORDER BY service_id",
      [tid, resourceId]
    );
    return res.json({ ok: true, resource_id: resourceId, tenant_id: tid, links: out.rows });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /api/links/resource/:id/services error:", err);
    return res.status(500).json({ error: "Failed to update resource links" });
  } finally {
    client.release();
  }
});

module.exports = router;
