// routes/tenantDomains.js
const express = require("express");
const dns = require("node:dns/promises");
const router = express.Router();

const db = require("../db");
const requireAdminOrTenantRole = require("../middleware/requireAdminOrTenantRole");
const { requireTenant } = require("../middleware/requireTenant");
const { getTenantIdFromSlug } = require("../utils/tenants");

// PR 129 — DNS verification target for CNAME checks. Tenants must point
// their custom domain's CNAME at this hostname before verification
// succeeds. Env-overridable so staging vs prod can differ.
const DNS_TARGET = String(
  process.env.FLEXREZ_CNAME_TARGET || "cname.flexrez.com",
)
  .trim()
  .toLowerCase()
  .replace(/\.$/, ""); // strip trailing dot if present

async function resolveTenantFromDomainRow(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const { rows } = await db.query("SELECT tenant_id FROM tenant_domains WHERE id = $1", [id]);
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    req.tenantId = Number(rows[0].tenant_id);
    req.body = req.body || {};
    req.body.tenantId = req.body.tenantId || req.tenantId;
    return next();
  } catch (e) {
    console.error("resolveTenantFromDomainRow error:", e);
    return res.status(500).json({ error: "Failed to resolve tenant." });
  }
}

/**
 * Tenant Custom Domains (v2 — PR 129)
 *
 * Admin CRUD:
 *   - GET    /api/tenant-domains?tenantSlug=... OR ?tenantId=...
 *   - POST   /api/tenant-domains  { tenantSlug|tenantId, domain }
 *                                 Newly added domains start in 'pending'
 *                                 state and require DNS verification.
 *                                 (isPrimary on POST is no longer accepted.)
 *   - POST   /api/tenant-domains/:id/verify?tenantId=<id>
 *                                 Runs a CNAME DNS lookup against
 *                                 FLEXREZ_CNAME_TARGET. Updates the row
 *                                 to 'active' + sets last_verified_at.
 *                                 On failure sets status='failed' with
 *                                 verification_error populated.
 *                                 Auto-promotes to primary when no other
 *                                 primary exists yet.
 *   - POST   /api/tenant-domains/:id/promote?tenantId=<id>
 *                                 Sets is_primary=true, demotes prior
 *                                 primary in the same transaction.
 *                                 Rejects if domain is not active.
 *   - DELETE /api/tenant-domains/:id?tenantId=<id>
 *                                 Removes a domain. Rejects primary
 *                                 domains (must promote another first).
 *
 * Public resolver (unchanged):
 *   - GET /api/tenant-domains/_public/resolve?domain=example.com
 *       -> { tenantId, tenantSlug }
 */

function normalizeDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^https?:\/\//i, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  // Strip an explicit port (e.g. example.com:443) if present.
  // Keep IPv6 literals intact (they come like [::1]:3000).
  if (d.startsWith("[")) {
    const m = d.match(/^\[[^\]]+\](?::\d+)?$/);
    if (m) d = d.replace(/:\d+$/, "");
  } else {
    const m = d.match(/^([^:]+):(\d+)$/);
    if (m) d = m[1];
  }
  d = d.replace(/\.$/, "");
  return d;
}

async function ensureTableExists() {
  const r = await db.query(`SELECT to_regclass('public.tenant_domains') AS reg`);
  return Boolean(r.rows?.[0]?.reg);
}

// PR 129 — authoritative server-side FQDN validation. Stricter than the
// client-side regex in GeneralSection.tsx because the server trusts
// nothing. Rules:
//   - length ≤ 253
//   - at least two labels (must contain a dot)
//   - each label 1–63 chars, a-z / 0-9 / hyphen, no leading or trailing hyphen
//   - lowercase only (normalizeDomain lowercases before this runs)
function isValidFqdn(s) {
  if (!s || typeof s !== "string") return false;
  if (s.length === 0 || s.length > 253) return false;
  if (!s.includes(".")) return false;
  const labels = s.split(".");
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return false;
  }
  return true;
}

// PR 129 — CNAME verification. Resolves CNAME records for `domain`
// and checks whether any pointer matches DNS_TARGET (case-insensitive,
// trailing-dot-tolerant).
//
// Returns { ok: true, records: [...] } on success.
// Returns { ok: false, reason: "..." } on failure with a message
// suitable to surface directly to the owner.
async function resolveCnameMatch(domain) {
  try {
    const records = await dns.resolveCname(domain);
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, reason: "No CNAME record found for this domain." };
    }
    const match = records.some((r) => {
      const normalized = String(r || "").trim().toLowerCase().replace(/\.$/, "");
      return normalized === DNS_TARGET;
    });
    if (!match) {
      return {
        ok: false,
        reason: `CNAME points to ${records[0]} but must point to ${DNS_TARGET}.`,
        records,
      };
    }
    return { ok: true, records };
  } catch (e) {
    // dns.resolveCname throws on NXDOMAIN, NODATA, ENOTFOUND, etc.
    const code = String(e && e.code ? e.code : "").toUpperCase();
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { ok: false, reason: "No CNAME record found for this domain." };
    }
    if (code === "ESERVFAIL" || code === "ETIMEOUT") {
      return { ok: false, reason: "DNS lookup timed out. Try again in a moment." };
    }
    return { ok: false, reason: `DNS lookup failed (${code || "unknown"}).` };
  }
}

// Admin: list domains for a tenant
router.get("/", requireTenant, requireAdminOrTenantRole("owner"), async (req, res) => {
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
      SELECT id, tenant_id, domain, is_primary, status,
             verification_error, last_verified_at,
             created_at, updated_at
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
router.post("/", requireTenant, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    if (!(await ensureTableExists())) {
      return res.status(500).json({
        error:
          "tenant_domains table missing. Run the migration that creates tenant_domains.",
      });
    }

    const domain = normalizeDomain(req.body?.domain);
    if (!domain) return res.status(400).json({ error: "Missing domain." });

    // PR 129: strict FQDN format check. Must be a bare hostname with at
    // least one dot, valid label chars, labels 1–63, total ≤ 253.
    if (!isValidFqdn(domain)) {
      return res.status(400).json({
        error: "Invalid domain. Enter a bare hostname like 'book.mybusiness.com'.",
      });
    }

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

    // PR 129: check for conflict with another tenant's active domain.
    // Same tenant re-adding their own domain is allowed (upsert below),
    // but one tenant cannot claim a domain already active for another.
    const conflict = await db.query(
      `SELECT tenant_id FROM tenant_domains WHERE domain = $1`,
      [domain],
    );
    if (conflict.rows[0] && Number(conflict.rows[0].tenant_id) !== tenantId) {
      return res.status(409).json({
        error: "This domain is already registered to a different tenant.",
      });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // PR 129: insert as 'pending' — DNS verification gates promotion
      // to 'active'. Never auto-set is_primary on creation — promotion
      // happens via POST /:id/verify (auto when first domain) or
      // /:id/promote (manual).
      const ins = await client.query(
        `
        INSERT INTO tenant_domains (tenant_id, domain, is_primary, status)
        VALUES ($1, $2, FALSE, 'pending')
        ON CONFLICT (domain) DO UPDATE
          SET tenant_id = EXCLUDED.tenant_id,
              status = CASE
                WHEN tenant_domains.tenant_id = EXCLUDED.tenant_id THEN tenant_domains.status
                ELSE 'pending'
              END,
              verification_error = NULL,
              updated_at = NOW()
        RETURNING id, tenant_id, domain, is_primary, status,
                  verification_error, last_verified_at, created_at, updated_at
        `,
        [tenantId, domain],
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

// ─── PR 129: Admin verify a domain's DNS ─────────────────────────────────────
// POST /api/tenant-domains/:id/verify
//
// Performs a CNAME lookup and updates the row:
//   success → status='active', verification_error=NULL, last_verified_at=NOW()
//   failure → status='failed', verification_error=<reason>, last_verified_at=NOW()
//
// Auto-promote first-verified domain for a tenant: if the tenant currently
// has no is_primary=true row, and this verification succeeds, the row is
// promoted to primary in the same transaction. Keeps the single-domain
// onboarding path friction-free.
router.post(
  "/:id/verify",
  resolveTenantFromDomainRow,
  requireAdminOrTenantRole("owner"),
  async (req, res) => {
    try {
      if (!(await ensureTableExists())) {
        return res.status(500).json({ error: "tenant_domains table missing." });
      }

      const id = Number(req.params.id);
      const tenantId = Number(req.tenantId);

      // Fetch the row — needed to know the domain string + current state
      const rowRes = await db.query(
        `SELECT id, tenant_id, domain, is_primary, status
           FROM tenant_domains
          WHERE id = $1 AND tenant_id = $2
          LIMIT 1`,
        [id, tenantId],
      );
      const row = rowRes.rows[0];
      if (!row) return res.status(404).json({ error: "Domain not found." });

      // Mark as 'verifying' so UI can reflect in-flight state. Safe to
      // update even if the row is currently 'active' — verification can
      // be re-run to revalidate an existing domain.
      await db.query(
        `UPDATE tenant_domains
           SET status = 'verifying', updated_at = NOW()
         WHERE id = $1`,
        [id],
      );

      const check = await resolveCnameMatch(row.domain);

      const client = await db.connect();
      try {
        await client.query("BEGIN");

        if (check.ok) {
          // Does this tenant already have a primary?
          const primaryExists = await client.query(
            `SELECT 1 FROM tenant_domains
              WHERE tenant_id = $1 AND is_primary = TRUE AND id <> $2
              LIMIT 1`,
            [tenantId, id],
          );
          const shouldAutoPromote = primaryExists.rows.length === 0;

          const upd = await client.query(
            `
            UPDATE tenant_domains
               SET status = 'active',
                   verification_error = NULL,
                   last_verified_at = NOW(),
                   is_primary = CASE WHEN $2 THEN TRUE ELSE is_primary END,
                   updated_at = NOW()
             WHERE id = $1
             RETURNING id, tenant_id, domain, is_primary, status,
                       verification_error, last_verified_at, created_at, updated_at
            `,
            [id, shouldAutoPromote],
          );

          await client.query("COMMIT");
          return res.json({ domain: upd.rows[0], verified: true });
        } else {
          const upd = await client.query(
            `
            UPDATE tenant_domains
               SET status = 'failed',
                   verification_error = $2,
                   last_verified_at = NOW(),
                   updated_at = NOW()
             WHERE id = $1
             RETURNING id, tenant_id, domain, is_primary, status,
                       verification_error, last_verified_at, created_at, updated_at
            `,
            [id, check.reason],
          );
          await client.query("COMMIT");
          return res
            .status(200)
            .json({ domain: upd.rows[0], verified: false, error: check.reason });
        }
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("tenant-domains verify error:", err);
      return res.status(500).json({ error: "Failed to verify domain." });
    }
  },
);

// ─── PR 129: Admin promote a domain to primary ───────────────────────────────
// POST /api/tenant-domains/:id/promote
//
// Promotes the target domain to primary, demoting the existing primary in
// a single transaction. Rejects non-active domains — a pending / failed
// domain cannot be primary, since it won't serve traffic.
router.post(
  "/:id/promote",
  resolveTenantFromDomainRow,
  requireAdminOrTenantRole("owner"),
  async (req, res) => {
    try {
      if (!(await ensureTableExists())) {
        return res.status(500).json({ error: "tenant_domains table missing." });
      }

      const id = Number(req.params.id);
      const tenantId = Number(req.tenantId);

      // Check target is active
      const rowRes = await db.query(
        `SELECT status FROM tenant_domains
          WHERE id = $1 AND tenant_id = $2
          LIMIT 1`,
        [id, tenantId],
      );
      const row = rowRes.rows[0];
      if (!row) return res.status(404).json({ error: "Domain not found." });
      if (String(row.status || "").toLowerCase() !== "active") {
        return res.status(400).json({
          error: "Only active domains can be promoted to primary. Verify DNS first.",
        });
      }

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE tenant_domains
              SET is_primary = FALSE, updated_at = NOW()
            WHERE tenant_id = $1 AND id <> $2 AND is_primary = TRUE`,
          [tenantId, id],
        );
        const upd = await client.query(
          `UPDATE tenant_domains
              SET is_primary = TRUE, updated_at = NOW()
            WHERE id = $1
           RETURNING id, tenant_id, domain, is_primary, status,
                     verification_error, last_verified_at, created_at, updated_at`,
          [id],
        );
        await client.query("COMMIT");
        return res.json({ domain: upd.rows[0] });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("tenant-domains promote error:", err);
      return res.status(500).json({ error: "Failed to promote domain." });
    }
  },
);

// Admin: delete domain mapping
router.delete("/:id", resolveTenantFromDomainRow, requireAdminOrTenantRole("owner"), async (req, res) => {
  try {
    if (!(await ensureTableExists())) {
      return res.status(500).json({ error: "tenant_domains table missing." });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: "Invalid id." });

    // PR 129: reject primary-domain deletion. Owners must promote
    // another domain to primary first — this prevents accidental
    // lockout where a tenant has no resolvable custom hostname.
    const row = await db.query(
      `SELECT is_primary FROM tenant_domains WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (!row.rows[0]) return res.status(404).json({ error: "Not found." });
    if (row.rows[0].is_primary) {
      return res.status(400).json({
        error:
          "Can't delete the primary domain. Promote another verified domain first.",
      });
    }

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

    const domain = normalizeDomain(
      req.query.domain || req.headers["x-forwarded-host"] || req.headers.host
    );
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
