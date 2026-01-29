// utils/ensureLinksSchema.js
//
// Phase 3 (relationships): create additive link tables if they don't exist.
// This is intentionally idempotent (safe to call on every boot).

const { pool } = require("../db");

let didRun = false;

async function ensureLinksSchema() {
  if (didRun) return;
  didRun = true;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Staff <-> Services
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_service_links (
        tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (staff_id, service_id)
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_staff_service_links_tenant_service ON staff_service_links(tenant_id, service_id);`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_staff_service_links_tenant_staff ON staff_service_links(tenant_id, staff_id);`
    );

    // Resources <-> Services
    await client.query(`
      CREATE TABLE IF NOT EXISTS resource_service_links (
        tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        resource_id  INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        service_id   INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (resource_id, service_id)
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_resource_service_links_tenant_service ON resource_service_links(tenant_id, service_id);`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_resource_service_links_tenant_resource ON resource_service_links(tenant_id, resource_id);`
    );

    // Staff <-> Resources (optional; future expansion)
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_resource_links (
        tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        resource_id  INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (staff_id, resource_id)
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_staff_resource_links_tenant_staff ON staff_resource_links(tenant_id, staff_id);`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_staff_resource_links_tenant_resource ON staff_resource_links(tenant_id, resource_id);`
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    // IMPORTANT: don't crash the app on schema ensure; log and allow APIs to respond with errors.
    console.error("ensureLinksSchema failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ensureLinksSchema };
