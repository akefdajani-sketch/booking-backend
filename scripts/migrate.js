'use strict';

// scripts/migrate.js
// PR-5: Migration System + DB Integrity
//
// Runs all pending SQL migrations from the /migrations folder in order.
// Tracks applied migrations in a `schema_migrations` table.
//
// Usage:
//   node scripts/migrate.js           — run all pending migrations
//   node scripts/migrate.js --list    — show status of all migrations
//   node scripts/migrate.js --dry-run — show pending without running
//
// In production (Render):
//   Add as a pre-start script or run manually via:
//   DATABASE_URL=... node scripts/migrate.js

require('dotenv').config({ path: '.env' });

const path = require('path');
const fs   = require('fs');
const { Pool } = require('pg');

const isProd = process.env.NODE_ENV === 'production';
const useSSL = process.env.DATABASE_SSL != null
  ? String(process.env.DATABASE_SSL).toLowerCase() === 'true'
  : isProd;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ─── Ensure tracking table ────────────────────────────────────────────────────

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ─── Load migration files ─────────────────────────────────────────────────────

function getMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // lexicographic = numeric order (001_, 002_, ...)
}

// ─── Get applied migrations ───────────────────────────────────────────────────

async function getApplied(client) {
  const { rows } = await client.query(
    `SELECT filename FROM schema_migrations ORDER BY filename ASC`
  );
  return new Set(rows.map(r => r.filename));
}

// ─── Run a single migration ───────────────────────────────────────────────────

async function runMigration(client, filename) {
  const filepath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filepath, 'utf8');

  // Wrap each migration in a transaction
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1)`,
      [filename]
    );
    await client.query('COMMIT');
    console.log(`  ✓ ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  ✗ ${filename} — FAILED: ${err.message}`);
    throw err;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const isList  = args.includes('--list');
  const isDry   = args.includes('--dry-run');

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const files   = getMigrationFiles();
    const pending = files.filter(f => !applied.has(f));

    if (isList) {
      console.log('\nMigration status:');
      for (const f of files) {
        console.log(`  ${applied.has(f) ? '✓' : '○'} ${f}`);
      }
      console.log(`\n${applied.size} applied, ${pending.length} pending\n`);
      return;
    }

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    if (isDry) {
      console.log(`\nPending migrations (dry-run):`);
      for (const f of pending) console.log(`  ○ ${f}`);
      console.log();
      return;
    }

    console.log(`\nRunning ${pending.length} migration(s)...`);
    for (const f of pending) {
      await runMigration(client, f);
    }
    console.log('\nDone.\n');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
