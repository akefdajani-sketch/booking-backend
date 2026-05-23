'use strict';
// scripts/check-schema-drift.js
// Lightweight schema-drift probe. Verifies that columns the code reads
// actually exist on the live DB. Exit 0 if all present, 1 if any missing.
//
// Usage:   DATABASE_SSL=true node scripts/check-schema-drift.js
// Wire into CI (or a Render pre-deploy hook) to fail the build on drift.
//
// To extend: append a {table, column} when you add code that reads a new
// column. Keep this list to columns whose absence would silently break a
// feature (not exhaustive — just the load-bearing ones).

require('dotenv').config();
const db = require('../db');

const REQUIRED_COLUMNS = [
  // 2026-05-23 incident #2: invites.js read u.name; prod has u.full_name.
  // The route caught the throw silently, never sent the email, never
  // wrote email_log. Cost: ~2 days of broken invites.
  { table: 'users',          column: 'full_name' },
  { table: 'users',          column: 'email' },
  { table: 'tenants',        column: 'name' },
  { table: 'tenants',        column: 'slug' },
  // 2026-05-23 incident #4: routes/publicTenantTheme.js depends on this column
  // to hydrate `tenant.timezone` on the public booking page. Frontend uses it
  // to convert customer slot picks into the correct UTC instant on submit;
  // missing it causes browser-tz fallback and timezone-shifted bookings.
  { table: 'tenants',        column: 'timezone' },
  { table: 'tenant_invites', column: 'token_hash' },
  { table: 'tenant_invites', column: 'accepted_at' },
  { table: 'email_log',      column: 'recipient' },
  { table: 'email_log',      column: 'kind' },
  { table: 'email_log',      column: 'status' },
];

const REQUIRED_INDEXES = [
  // 2026-05-23 incident #3: invites.js accept handler does
  // `ON CONFLICT (tenant_id, user_id) WHERE is_primary = true` on
  // tenant_user_roles. That requires this partial unique index. If it's
  // missing or renamed, accept throws PG 42P10 and every acceptance
  // returns a generic 500. Add a check that the name + uniqueness hold.
  { table: 'tenant_user_roles', name: 'tenant_user_roles_one_primary_uq', mustBeUnique: true },
];

(async () => {
  const missing = [];
  for (const { table, column } of REQUIRED_COLUMNS) {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column]
    );
    if (r.rows.length === 0) missing.push(`column ${table}.${column}`);
  }
  for (const { table, name, mustBeUnique } of REQUIRED_INDEXES) {
    const r = await db.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname='public' AND tablename=$1 AND indexname=$2`,
      [table, name]
    );
    if (r.rows.length === 0) {
      missing.push(`index ${table}.${name} (not present)`);
    } else if (mustBeUnique && !/CREATE UNIQUE INDEX/i.test(r.rows[0].indexdef)) {
      missing.push(`index ${table}.${name} (exists but not UNIQUE)`);
    }
  }
  if (missing.length) {
    console.error('Schema drift detected:');
    missing.forEach(m => console.error('  - ' + m));
    process.exit(1);
  }
  console.log(
    `Schema check passed (${REQUIRED_COLUMNS.length} columns + ${REQUIRED_INDEXES.length} indexes verified).`
  );
  process.exit(0);
})().catch(e => {
  console.error('Schema check failed:', e.message);
  process.exit(2);
});
