// utils/rbac.js
// Minimal RBAC helpers for tenant-scoped Users & Roles (Phase D2).
//
// Goals:
// - Ensure required tables exist (safe in dev + new environments)
// - Provide a safe "first user becomes owner" bootstrap path per tenant
//
// NOTE: This is intentionally lightweight (role-based, not per-permission).

const db = require("../db");

let ensured = false;

async function ensureRbacTables() {
  if (ensured) return;

  // tenant_users
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_users (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      is_primary BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, user_id)
    );
  `);

  // tenant_invites
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_invites (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      invited_by_user_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, email, token_hash)
    );
  `);

  // Helpful indexes (best-effort)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users(tenant_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant ON tenant_invites(tenant_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_invites_token_hash ON tenant_invites(token_hash);`);

  ensured = true;
}

async function ensureBootstrapOwner({ tenantId, userId }) {
  const tid = Number(tenantId);
  const uid = Number(userId);
  if (!Number.isFinite(tid) || tid <= 0) return null;
  if (!Number.isFinite(uid) || uid <= 0) return null;

  await ensureRbacTables();

  // If tenant already has members, do nothing.
  const existing = await db.query(
    `SELECT 1 FROM tenant_users WHERE tenant_id = $1 LIMIT 1`,
    [tid]
  );
  if (existing.rows.length) return null;

  // Bootstrap: first user to access becomes owner + primary.
  // This is safe because:
  // - It only triggers when the tenant has *zero* members.
  // - After one member exists, further calls cannot claim ownership.
  await db.query(
    `
    INSERT INTO tenant_users (tenant_id, user_id, role, is_primary)
    VALUES ($1, $2, 'owner', true)
    ON CONFLICT (tenant_id, user_id)
    DO UPDATE SET role = 'owner', is_primary = true, updated_at = now()
    `,
    [tid, uid]
  );

  return "owner";
}

module.exports = {
  ensureRbacTables,
  ensureBootstrapOwner,
};
