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
  // 2026-05-23 incident: invites.js read u.name; prod has u.full_name.
  // The route caught the throw silently, never sent the email, never
  // wrote email_log. Cost: ~2 days of broken invites.
  { table: 'users',          column: 'full_name' },
  { table: 'users',          column: 'email' },
  { table: 'tenants',        column: 'name' },
  { table: 'tenants',        column: 'slug' },
  { table: 'tenant_invites', column: 'token_hash' },
  { table: 'tenant_invites', column: 'accepted_at' },
  { table: 'email_log',      column: 'recipient' },
  { table: 'email_log',      column: 'kind' },
  { table: 'email_log',      column: 'status' },
];

(async () => {
  const missing = [];
  for (const { table, column } of REQUIRED_COLUMNS) {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column]
    );
    if (r.rows.length === 0) missing.push(`${table}.${column}`);
  }
  if (missing.length) {
    console.error('Schema drift detected — missing columns:');
    missing.forEach(m => console.error('  - ' + m));
    process.exit(1);
  }
  console.log(`Schema check passed (${REQUIRED_COLUMNS.length} columns verified).`);
  process.exit(0);
})().catch(e => {
  console.error('Schema check failed:', e.message);
  process.exit(2);
});
