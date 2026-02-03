// utils/tenants.js
const db = require("../db");

/**
 * Resolve tenant_id from tenant slug.
 * Throws an Error if not found.
 *
 * @param {string} slug
 * @returns {Promise<number>}
 */
async function getTenantIdFromSlug(slug) {
  const clean = String(slug || "").trim();

  if (!clean) {
    throw new Error("Missing tenantSlug");
  }

  const result = await db.query(
    `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
    [clean]
  );

  const id = result.rows?.[0]?.id;

  if (!id) {
    const err = new Error(`Tenant not found for slug: ${clean}`);
    err.code = "TENANT_NOT_FOUND";
    throw err;
  }

  return id;
}

/**
 * Optional helper: resolve tenant row from slug
 * (handy for future endpoints).
 */
async function getTenantBySlug(slug) {
  const clean = String(slug || "").trim();
  if (!clean) throw new Error("Missing tenantSlug");

  const result = await db.query(
    `
    SELECT id, slug, name, kind, timezone, logo_url, cover_image_url, created_at
    FROM tenants
    WHERE slug = $1
    LIMIT 1
    `,
    [clean]
  );

  const tenant = result.rows?.[0] || null;

  if (!tenant) {
    const err = new Error(`Tenant not found for slug: ${clean}`);
    err.code = "TENANT_NOT_FOUND";
    throw err;
  }

  return tenant;
}

/**
 * Resolve tenant (id + slug) by custom domain.
 * Used by /api/tenant-domains/_public/resolve.
 *
 * Notes:
 * - Expects tenant_domains.domain stored in lowercase.
 * - Supports resolving both root and www forms.
 * - If tenant_domains table doesn't exist (older env), returns null.
 */
async function getTenantByDomain(domainRaw) {
  let d = String(domainRaw || "").trim().toLowerCase();
  if (!d) throw new Error("Missing domain");

  // strip scheme/path
  d = d.replace(/^https?:\/\//i, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.replace(/\.$/, "");

  const candidates = [d];
  if (d.startsWith("www.")) candidates.push(d.slice(4));
  else candidates.push("www." + d);

  const exists = await db.query(
    `SELECT to_regclass('public.tenant_domains') AS reg`
  );
  if (!exists.rows?.[0]?.reg) return null;

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
  if (!row) return null;

  return { tenantId: Number(row.tenant_id), tenantSlug: row.slug };
}

module.exports = {
  getTenantIdFromSlug,
  getTenantBySlug,
  getTenantByDomain,
};
