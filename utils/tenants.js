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

module.exports = {
  getTenantIdFromSlug,
  getTenantBySlug,
};
