// routes/tenantDomains.js
const express = require("express");
const router = express.Router();

const db = require("../db");
const requireAdmin = require("../middleware/requireAdmin");
const { getTenantIdFromSlug } = require("../utils/tenants");

/**
 * Tenant Custom Domains (v1)
 *
 * Admin CRUD:
 *   - GET    /api/tenant-domains?tenantSlug=... OR ?tenantId=...
 *   - POST   /api/tenant-domains  { tenantSlug|tenantId, domain, isPrimary }
 *   - DELETE /api/tenant-domains/:id
 *
 * Public resolver:
 *   - GET /api/tenant-domains/_public/resolve?domain=example.com
 *       -> { tenantId, tenantSlug }
 */

function normalizeDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^https?:\/\//i, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.replace(/\.$/, "");
  return d;
}

async function ensureTableExists() {
  const r = await db.query(`SELECT to_regclass('public.tenant_domains') AS reg`);
  return Boolean(r.rows?.[0]?.reg);
}

// Admin: list domains for a tenant
router.get("/", requireAdmin, async (req, res) => {
  try {
    if (!(await ensureTableExists())) {
      return res.status(500).json({
        error:
          "tenant_domains table missing. Run the migration that creates tenant_domains.",
      });
    }

    const tenantSlug = String(req.query.tenantSlug || "").trim();
    const tenantIdRaw = String(req.query.tenantId || "").trim();

    let tenantId = null;
    if (tenantSlug) tenantId = await getTenantIdFromSlug(tenantSlug);
    else if (tenantIdRaw) {
      const tid = Number(tenantIdRaw);
      if (!Number.isFinite(tid) || tid <= 0)
        return res.status(400).json({ error: "Invalid tenantId." });
      tenantId = tid;
    } else {
      return res.status(400).json({ error: "Provide tenantId or tenantSlug." });
    }

    const r = await db.query(
      `
      SELECT id, tenant_id, domain, is_primary, status, created_at, updated_at
      FROM tenant_domains
      WHERE tenant_id = $1
      ORDER BY is_primary DESC, domain ASC
      `,
      [tenantId]
    );

    return res.json({ tenantId, domains: r.rows });
  } catch (err) {
    console.error("tenant-domains list error:", err);
    return res.status(500).json({ error: "Failed to list tenant domains." });
  }
});

// Admin: add/update domain for a tenant
router.post("/", requireAdmin, async (req, res) => {
  try {
    if (!(await ensureTableExists())) {
      return res.status(500).json({
        error:
          "tenant_domains table missing. Run the migration that creates tenant_domains.",
      });
    }

    const domain = normalizeDomain(req.body?.domain);
    if (!domain) return res.status(400).json({ error: "Missing domain." });

    const tenantSlug = String(req.body?.tenantSlug || "").trim();
    const tenantIdRaw = req.body?.tenantId;

    let tenantId = null;
    if (tenantSlug) tenantId = await getTenantIdFromSlug(tenantSlug);
    else if (tenantIdRaw != null && String(tenantIdRaw).trim() !== "") {
      const tid = Number(tenantIdRaw);
      if (!Number.isFinite(tid) || tid <= 0)
        return res.status(400).json({ error: "Invalid tenantId." });
      tenantId = tid;
    } else {
      return res.status(400).json({ error: "Provide tenantId or tenantSlug." });
    }

    const isPrimary = Boolean(req.body?.isPrimary);

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Only one primary domain per tenant
      if (isPrimary) {
        await client.query(
          `UPDATE tenant_domains SET is_primary = FALSE, updated_at = NOW() WHERE tenant_id = $1`,
          [tenantId]
        );
      }

      // Upsert based on UNIQUE(domain)
      const ins = await client.query(
        `
        INSERT INTO tenant_domains (tenant_id, domain, is_primary, status)
        VALUES ($1, $2, $3, 'active')
        ON CONFLICT (domain) DO UPDATE
          SET tenant_id = EXCLUDED.tenant_id,
              is_primary = EXCLUDED.is_primary,
              status = 'active',
              updated_at = NOW()
        RETURNING id, tenant_id, domain, is_primary, status, created_at, updated_at
        `,
        [tenantId, domain, isPrimary]
      );

      await client.query("COMMIT");
      return res.status(201).json({ domain: ins.rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("tenant-domains create error:", err);
    return res.status(500).json({ error: "Failed to add tenant domain." });
  }
});

// Admin: delete domain mapping
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    if (!(await ensureTableExists())) {
      return res.status(500).json({ error: "tenant_domains table missing." });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: "Invalid id." });

    const r = await db.query(`DELETE FROM tenant_domains WHERE id = $1 RETURNING id`, [
      id,
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Not found." });

    return res.json({ ok: true });
  } catch (err) {
    console.error("tenant-domains delete error:", err);
    return res.status(500).json({ error: "Failed to delete tenant domain." });
  }
});

// Public: resolve domain -> tenantSlug
router.get("/_public/resolve", async (req, res) => {
  try {
    if (!(await ensureTableExists())) {
      return res.status(404).json({ error: "Domains not configured." });
    }

    const domain = normalizeDomain(req.query.domain);
    if (!domain) return res.status(400).json({ error: "Missing domain." });

    const candidates = [domain];
    if (domain.startsWith("www.")) candidates.push(domain.slice(4));
    else candidates.push("www." + domain);

    const r = await db.query(
      `
      SELECT td.tenant_id, t.slug
      FROM tenant_domains td
      JOIN tenants t ON t.id = td.tenant_id
      WHERE td.domain = ANY($1::text[])
        AND td.status = 'active'
      ORDER BY td.is_primary DESC
      LIMIT 1
      `,
      [candidates]
    );

    const row = r.rows?.[0];
    if (!row) return res.status(404).json({ error: "Unknown domain." });

    return res.json({ tenantId: Number(row.tenant_id), tenantSlug: row.slug });
  } catch (err) {
    console.error("resolve-tenant error:", err);
    return res.status(500).json({ error: "Failed to resolve domain." });
  }
});

module.exports = router;
