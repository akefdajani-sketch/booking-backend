'use strict';

// audit/2026-05-14/schema_drift/probe.js
//
// READ-ONLY schema-drift probe. SELECT-only — no DDL, no DML, no writes.
// Modeled on scripts/probe_schema.js. Substitute for the brief's
// tools/db_audit.sql (which does not exist in this repo).
//
// Run from repo root:  DATABASE_SSL=true node audit/2026-05-14/schema_drift/probe.js
// Loads DATABASE_URL from .env (prod Render PG per project memory).

require('dotenv').config();
const { Pool } = require('pg');

const isProd = process.env.NODE_ENV === 'production';
const useSSL = process.env.DATABASE_SSL != null
  ? String(process.env.DATABASE_SSL).toLowerCase() === 'true'
  : isProd;

function section(title) {
  console.log(`\n===== ${title} =====`);
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    // ── Phase 1: connectivity ────────────────────────────────────────────────
    section('PHASE1_TENANT_COUNT');
    const tc = await pool.query('SELECT count(*)::int AS n FROM tenants');
    console.log(JSON.stringify(tc.rows[0]));

    // ── Phase 2: full schema_migrations contents ─────────────────────────────
    section('PHASE2_SCHEMA_MIGRATIONS');
    const sm = await pool.query(
      `SELECT id, filename, applied_at
         FROM schema_migrations
        ORDER BY filename ASC`
    );
    console.log(JSON.stringify(sm.rows, null, 2));
    console.log(`ROW_COUNT: ${sm.rowCount}`);

    // ── Phase 5: Migration 052 — tenants notification toggles ────────────────
    section('M052_TENANTS_SMS_WA_TOGGLES');
    const m052 = await pool.query(
      `SELECT column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenants'
          AND (column_name LIKE 'sms_%_enabled' OR column_name LIKE 'wa_%_enabled')
        ORDER BY column_name`
    );
    console.log(JSON.stringify(m052.rows, null, 2));
    console.log(`COUNT: ${m052.rowCount} (expected 8 if applied)`);

    // ── Phase 5: Migration 055 — email toggles + booking stamps + indexes ────
    section('M055_TENANTS_EMAIL_TOGGLES');
    const m055a = await pool.query(
      `SELECT column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenants'
          AND column_name LIKE 'email_%_enabled'
        ORDER BY column_name`
    );
    console.log(JSON.stringify(m055a.rows, null, 2));
    console.log(`COUNT: ${m055a.rowCount} (expected 4 if applied)`);

    section('M055_BOOKINGS_EMAIL_REMINDER_STAMPS');
    const m055b = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bookings'
          AND column_name LIKE 'email_reminder_sent_%'
        ORDER BY column_name`
    );
    console.log(JSON.stringify(m055b.rows, null, 2));
    console.log(`COUNT: ${m055b.rowCount} (expected 2 if applied)`);

    section('M055_BOOKINGS_EMAIL_REMINDER_INDEXES');
    const m055c = await pool.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'bookings'
          AND indexname LIKE 'idx_bookings_email_reminder_pending_%'
        ORDER BY indexname`
    );
    console.log(JSON.stringify(m055c.rows, null, 2));
    console.log(`COUNT: ${m055c.rowCount} (expected 2 if applied)`);

    // ── Phase 5: Migration 066 — voice_prompt_snapshot ───────────────────────
    section('M066_TENANTS_VOICE_PROMPT_SNAPSHOT');
    const m066 = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenants'
          AND column_name = 'voice_prompt_snapshot'`
    );
    console.log(JSON.stringify(m066.rows, null, 2));
    console.log(`COUNT: ${m066.rowCount} (expected 1 jsonb if applied)`);

    // ── Phase 5: Migrations 069 + 070 — themes V2 ────────────────────────────
    section('M069_070_THEMES_V2_TABLES');
    const tv2tables = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('platform_themes','platform_shells','platform_layouts')
        ORDER BY table_name`
    );
    console.log('TABLES PRESENT:', JSON.stringify(tv2tables.rows.map(r => r.table_name)));

    for (const t of ['platform_themes', 'platform_shells', 'platform_layouts']) {
      if (tv2tables.rows.some(r => r.table_name === t)) {
        const c = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
        console.log(`  ${t}: ${c.rows[0].n} rows`);
      } else {
        console.log(`  ${t}: TABLE MISSING`);
      }
    }

    section('M069_PLATFORM_THEMES_ORPHAN_CHECK');
    if (tv2tables.rows.some(r => r.table_name === 'platform_themes')) {
      const orphan = await pool.query(
        `SELECT key FROM platform_themes WHERE key = 'premuim_light_v2'`
      );
      console.log(`premuim_light_v2 orphan rows: ${orphan.rowCount} (expected 0 if 069 applied)`);
      const keys = await pool.query(`SELECT key, is_published FROM platform_themes ORDER BY key`);
      console.log(JSON.stringify(keys.rows, null, 2));
    }

    section('M070_PLATFORM_SHELLS_LAYOUTS_SEED');
    if (tv2tables.rows.some(r => r.table_name === 'platform_shells')) {
      const sh = await pool.query(`SELECT key, name FROM platform_shells ORDER BY key`);
      console.log('SHELLS:', JSON.stringify(sh.rows));
    }
    if (tv2tables.rows.some(r => r.table_name === 'platform_layouts')) {
      const ly = await pool.query(`SELECT key, name FROM platform_layouts ORDER BY key`);
      console.log('LAYOUTS:', JSON.stringify(ly.rows));
    }

    section('M070_TENANTS_SHELL_LAYOUT_COLUMNS');
    const m070 = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenants'
          AND column_name IN ('shell_key','layout_key_v2')
        ORDER BY column_name`
    );
    console.log(JSON.stringify(m070.rows, null, 2));
    console.log(`COUNT: ${m070.rowCount} (expected 2 if 070 applied)`);

    // ── Snapshot support: all public tables + row estimates ──────────────────
    section('ALL_PUBLIC_TABLES');
    const tables = await pool.query(
      `SELECT t.table_name,
              (SELECT count(*) FROM information_schema.columns c
                WHERE c.table_schema = 'public' AND c.table_name = t.table_name) AS column_count
         FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`
    );
    console.log(JSON.stringify(tables.rows, null, 2));
    console.log(`TABLE_COUNT: ${tables.rowCount}`);

    // ── Spot-check a sample of RECORDED migrations actually applied ──────────
    // Catches the inverse drift: recorded in schema_migrations but effects absent.
    section('SPOTCHECK_RECORDED_MIGRATIONS');
    const spot = await pool.query(
      `SELECT
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='tenants'
             AND column_name='voice_instructions') AS m059_voice_instructions,
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='services'
             AND column_name='is_long_term') AS m061_services_is_long_term,
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='bookings'
             AND column_name='payment_status') AS m064_bookings_payment_status,
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='tenants'
             AND column_name='booking_flow_preset') AS m068_tenants_booking_flow_preset,
         (SELECT count(*) FROM information_schema.tables
           WHERE table_schema='public' AND table_name='email_log') AS m054_email_log_table,
         (SELECT count(*) FROM information_schema.tables
           WHERE table_schema='public' AND table_name='class_sessions') AS m051_class_sessions_table`
    );
    console.log(JSON.stringify(spot.rows[0], null, 2));

    console.log('\n===== PROBE COMPLETE =====');
  } catch (e) {
    console.error('PROBE ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
