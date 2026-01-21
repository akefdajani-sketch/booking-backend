// routes/tenantBlackouts.js
// Tenant blackout windows (closures) that block booking availability.
//
// GET  /api/tenant-blackouts?tenantSlug=&tenantId=
// POST /api/tenant-blackouts   (admin only)
// PUT  /api/tenant-blackouts/:id (admin only)
// DELETE /api/tenant-blackouts/:id (admin only)  -> soft delete (is_active=false)

const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const db = pool;

const requireAdmin = require("../middleware/requireAdmin");
const { getTenantIdFromSlug } = require("../utils/tenants");

async function resolveTenantIdFromQuery(query) {
  const tenantSlug = query?.tenantSlug ?? query?.slug ?? query?.tenant_slug ?? null;
  const tenantIdRaw = query?.tenantId ?? query?.tenant_id ?? query?.tenantID ?? null;

  let resolvedTenantId = tenantIdRaw != null && String(tenantIdRaw).trim() !== "" ? Number(tenantIdRaw) : null;
  if (!resolvedTenantId && tenantSlug) {
    resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
  }
  if (!resolvedTenantId || !Number.isFinite(resolvedTenantId)) return null;
  return Number(resolvedTenantId);
}

async function getTenantTimezone(tenantId) {
  const r = await db.query("SELECT timezone FROM tenants WHERE id=$1", [Number(tenantId)]);
  return r.rows?.[0]?.timezone || "UTC";
}

function clampText(v, maxLen) {
  const s = v == null ? "" : String(v);
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

async function findOverlappingBlackout({ tenantId, startsAt, endsAt, resourceId, staffId, serviceId, ignoreId }) {
  const tid = Number(tenantId);
  const iid = ignoreId != null ? Number(ignoreId) : null;
  const rid = resourceId != null ? Number(resourceId) : null;
  const sid = staffId != null ? Number(staffId) : null;
  const svc = serviceId != null ? Number(serviceId) : null;

  const r = await db.query(
    `
    SELECT id, starts_at, ends_at, reason
    FROM tenant_blackouts
    WHERE tenant_id = $1
      AND is_active = TRUE
      AND ($2::bigint IS NULL OR id <> $2::bigint)
      AND tstzrange(starts_at, ends_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
      AND (resource_id IS NULL OR resource_id = $5)
      AND (staff_id IS NULL OR staff_id = $6)
      AND (service_id IS NULL OR service_id = $7)
    ORDER BY starts_at ASC
    LIMIT 1
    `,
    [tid, iid, startsAt, endsAt, rid, sid, svc]
  );
  return r.rows?.[0] || null;
}

// GET list
router.get("/", async (req, res) => {
  try {
    const resolvedTenantId = await resolveTenantIdFromQuery(req.query);
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "You must provide tenantSlug or tenantId." });
    }

    const includeInactive = String(req.query.includeInactive || "").toLowerCase() === "true";

    const r = await db.query(
      `
      SELECT
        id,
        tenant_id,
        starts_at,
        ends_at,
        resource_id,
        staff_id,
        service_id,
        reason,
        is_active,
        created_at,
        updated_at
      FROM tenant_blackouts
      WHERE tenant_id = $1
        AND ($2::bool = TRUE OR is_active = TRUE)
      ORDER BY starts_at ASC
      `,
      [resolvedTenantId, includeInactive]
    );

    return res.json({ blackouts: r.rows });
  } catch (err) {
    console.error("Error loading tenant blackouts:", err);
    return res.status(500).json({ error: "Failed to load tenant blackouts." });
  }
});

// POST create
router.post("/", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    const tenantSlug = body.tenantSlug ?? body.slug ?? body.tenant_slug ?? null;
    const tenantIdRaw = body.tenantId ?? body.tenant_id ?? body.tenantID ?? null;
    let resolvedTenantId = tenantIdRaw != null && String(tenantIdRaw).trim() !== "" ? Number(tenantIdRaw) : null;
    if (!resolvedTenantId && tenantSlug) {
      resolvedTenantId = await getTenantIdFromSlug(String(tenantSlug));
    }
    if (!resolvedTenantId || !Number.isFinite(resolvedTenantId)) {
      return res.status(400).json({ error: "You must provide tenantSlug or tenantId." });
    }

    // Prefer tenant-local inputs (recommended). Fallback to ISO inputs if provided.
    const startsLocal = body.startsLocal ?? body.starts_local ?? null; // "YYYY-MM-DDTHH:MM"
    const endsLocal = body.endsLocal ?? body.ends_local ?? null;

    const startsAtIso = body.startsAt ?? body.starts_at ?? null; // ISO string
    const endsAtIso = body.endsAt ?? body.ends_at ?? null;

    let startsAt = null;
    let endsAt = null;

    if (startsLocal && endsLocal) {
      const tz = await getTenantTimezone(resolvedTenantId);
      const conv = await db.query(
        `
        SELECT
          ($1::timestamp AT TIME ZONE $3) AS starts_at,
          ($2::timestamp AT TIME ZONE $3) AS ends_at
        `,
        [String(startsLocal), String(endsLocal), tz]
      );
      startsAt = conv.rows?.[0]?.starts_at || null;
      endsAt = conv.rows?.[0]?.ends_at || null;
    } else if (startsAtIso && endsAtIso) {
      startsAt = new Date(String(startsAtIso));
      endsAt = new Date(String(endsAtIso));
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
        return res.status(400).json({ error: "Invalid startsAt/endsAt." });
      }
      startsAt = startsAt.toISOString();
      endsAt = endsAt.toISOString();
    }

    if (!startsAt || !endsAt) {
      return res.status(400).json({ error: "startsLocal/endsLocal (recommended) or startsAt/endsAt are required." });
    }

    const reason = clampText(body.reason, 500);

    const resourceId = body.resourceId ?? body.resource_id ?? null;
    const staffId = body.staffId ?? body.staff_id ?? null;
    const serviceId = body.serviceId ?? body.service_id ?? null;

    // Basic validation (MVP expects tenant-wide closures, so these are optional)
    const resource_id = resourceId != null && String(resourceId).trim() !== "" ? Number(resourceId) : null;
    const staff_id = staffId != null && String(staffId).trim() !== "" ? Number(staffId) : null;
    const service_id = serviceId != null && String(serviceId).trim() !== "" ? Number(serviceId) : null;

    // Prevent creating duplicate/overlapping blackout windows (for the same scope).
    const existingOverlap = await findOverlappingBlackout({
      tenantId: resolvedTenantId,
      startsAt,
      endsAt,
      resourceId: resource_id,
      staffId: staff_id,
      serviceId: service_id,
      ignoreId: null,
    });
    if (existingOverlap) {
      return res.status(409).json({
        error: "Blackout overlaps an existing blackout.",
        overlap: existingOverlap,
      });
    }

    const insert = await db.query(
      `
      INSERT INTO tenant_blackouts
        (tenant_id, starts_at, ends_at, resource_id, staff_id, service_id, reason, is_active)
      VALUES
        ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, TRUE)
      RETURNING
        id, tenant_id, starts_at, ends_at, resource_id, staff_id, service_id, reason, is_active, created_at, updated_at
      `,
      [resolvedTenantId, startsAt, endsAt, resource_id, staff_id, service_id, reason]
    );

    return res.json({ blackout: insert.rows[0] });
  } catch (err) {
    console.error("Error creating tenant blackout:", err);
    return res.status(500).json({ error: "Failed to create tenant blackout." });
  }
});

// PUT update
router.put("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id." });

    const body = req.body || {};
    const resolvedTenantId = await resolveTenantIdFromQuery(body);
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "You must provide tenantSlug or tenantId." });
    }

    const startsLocal = body.startsLocal ?? body.starts_local ?? null;
    const endsLocal = body.endsLocal ?? body.ends_local ?? null;
    const startsAtIso = body.startsAt ?? body.starts_at ?? null;
    const endsAtIso = body.endsAt ?? body.ends_at ?? null;

    let startsAt = null;
    let endsAt = null;

    if (startsLocal && endsLocal) {
      const tz = await getTenantTimezone(resolvedTenantId);
      const conv = await db.query(
        `
        SELECT
          ($1::timestamp AT TIME ZONE $3) AS starts_at,
          ($2::timestamp AT TIME ZONE $3) AS ends_at
        `,
        [String(startsLocal), String(endsLocal), tz]
      );
      startsAt = conv.rows?.[0]?.starts_at || null;
      endsAt = conv.rows?.[0]?.ends_at || null;
    } else if (startsAtIso && endsAtIso) {
      const s = new Date(String(startsAtIso));
      const e = new Date(String(endsAtIso));
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
        return res.status(400).json({ error: "Invalid startsAt/endsAt." });
      }
      startsAt = s.toISOString();
      endsAt = e.toISOString();
    }

    const reason = clampText(body.reason, 500);
    const isActive = body.isActive ?? body.is_active;

    // Prevent updating into an overlapping window.
    const current = await db.query(
      `SELECT starts_at, ends_at, resource_id, staff_id, service_id FROM tenant_blackouts WHERE id=$1 AND tenant_id=$2`,
      [id, resolvedTenantId]
    );
    if (!current.rows.length) return res.status(404).json({ error: "Not found." });
    const cur = current.rows[0];
    const finalStarts = startsAt || cur.starts_at;
    const finalEnds = endsAt || cur.ends_at;

    const existingOverlap = await findOverlappingBlackout({
      tenantId: resolvedTenantId,
      startsAt: finalStarts,
      endsAt: finalEnds,
      resourceId: cur.resource_id,
      staffId: cur.staff_id,
      serviceId: cur.service_id,
      ignoreId: id,
    });
    if (existingOverlap) {
      return res.status(409).json({
        error: "Blackout overlaps an existing blackout.",
        overlap: existingOverlap,
      });
    }

    const upd = await db.query(
      `
      UPDATE tenant_blackouts
      SET
        starts_at = COALESCE($3::timestamptz, starts_at),
        ends_at   = COALESCE($4::timestamptz, ends_at),
        reason    = COALESCE($5::text, reason),
        is_active = COALESCE($6::boolean, is_active),
        updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
      RETURNING
        id, tenant_id, starts_at, ends_at, resource_id, staff_id, service_id, reason, is_active, created_at, updated_at
      `,
      [id, resolvedTenantId, startsAt, endsAt, reason, typeof isActive === "boolean" ? isActive : null]
    );

    if (!upd.rows.length) return res.status(404).json({ error: "Not found." });
    return res.json({ blackout: upd.rows[0] });
  } catch (err) {
    console.error("Error updating tenant blackout:", err);
    return res.status(500).json({ error: "Failed to update tenant blackout." });
  }
});

// DELETE (soft)
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id." });

    const resolvedTenantId = await resolveTenantIdFromQuery(req.query);
    if (!resolvedTenantId) {
      return res.status(400).json({ error: "You must provide tenantSlug or tenantId." });
    }

    const upd = await db.query(
      `
      UPDATE tenant_blackouts
      SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
      RETURNING id
      `,
      [id, resolvedTenantId]
    );

    if (!upd.rows.length) return res.status(404).json({ error: "Not found." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting tenant blackout:", err);
    return res.status(500).json({ error: "Failed to delete tenant blackout." });
  }
});

module.exports = router;
