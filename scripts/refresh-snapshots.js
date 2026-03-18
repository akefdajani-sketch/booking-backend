#!/usr/bin/env node
/**
 * refresh-snapshots.js
 * ─────────────────────────────────────────────────────────────────────────
 * Bulk-refreshes appearance snapshots for all published tenants.
 *
 * Run from the booking-backend root:
 *
 *   node scripts/refresh-snapshots.js              # all published tenants
 *   node scripts/refresh-snapshots.js --dry-run    # preview only, no writes
 *   node scripts/refresh-snapshots.js --slug birdie-golf   # single tenant
 *   node scripts/refresh-snapshots.js --stale-only # only out-of-date snapshots
 *
 * Environment:
 *   DATABASE_URL  — required (same as the main app)
 *   DATABASE_SSL  — optional (default: true in production)
 *
 * Exit codes:
 *   0  all snapshots refreshed successfully
 *   1  one or more tenants failed (details printed to stderr)
 */

"use strict";

require("dotenv").config();

const db = require("../db");
const {
  resolveTenantAppearanceSnapshot,
  writeTenantAppearanceSnapshot,
} = require("../theme/resolveTenantAppearanceSnapshot");

// ── CLI flags ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN    = args.includes("--dry-run");
const STALE_ONLY = args.includes("--stale-only");
const slugIdx    = args.indexOf("--slug");
const TARGET_SLUG = slugIdx !== -1 ? args[slugIdx + 1] : null;

// Must match the marker in resolveTenantAppearanceSnapshot.js
// (duplicated here so the script can detect stale snapshots without loading the module)
const CURRENT_MARKER = "plg2-assets-v3";

// ── Helpers ───────────────────────────────────────────────────────────────
function isStale(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return true;
  if (snapshot.debugSnapshotMarker !== CURRENT_MARKER) return true;
  const vars = snapshot.resolvedCssVars;
  if (!vars || typeof vars !== "object") return true;
  // Quick sanity: a healthy snapshot has at least 80 vars
  if (Object.keys(vars).length < 80) return true;
  return false;
}

function fmt(n, total) {
  return `[${String(n).padStart(String(total).length)}/${total}]`;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("─".repeat(60));
  console.log("Booking appearance snapshot refresh");
  console.log(`  mode:       ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`  target:     ${TARGET_SLUG || (STALE_ONLY ? "stale snapshots only" : "all published")}`);
  console.log(`  marker:     ${CURRENT_MARKER}`);
  console.log("─".repeat(60));

  // Fetch tenants
  let query, params;
  if (TARGET_SLUG) {
    query  = `SELECT id, slug, theme_key, publish_status,
                     appearance_snapshot_published_json,
                     appearance_snapshot_version
              FROM tenants WHERE slug = $1`;
    params = [TARGET_SLUG];
  } else {
    query  = `SELECT id, slug, theme_key, publish_status,
                     appearance_snapshot_published_json,
                     appearance_snapshot_version
              FROM tenants
              WHERE publish_status = 'published'
              ORDER BY id`;
    params = [];
  }

  const { rows: tenants } = await db.query(query, params);

  if (tenants.length === 0) {
    console.log("No tenants found matching criteria.");
    process.exit(0);
  }

  console.log(`Found ${tenants.length} tenant(s) to process.\n`);

  let skipped = 0, refreshed = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < tenants.length; i++) {
    const tenant = tenants[i];
    const prefix = fmt(i + 1, tenants.length);
    const existingSnapshot = tenant.appearance_snapshot_published_json;
    const stale = isStale(existingSnapshot);
    const currentMarker = existingSnapshot?.debugSnapshotMarker || "none";
    const varCount = existingSnapshot?.resolvedCssVars
      ? Object.keys(existingSnapshot.resolvedCssVars).length
      : 0;

    if (STALE_ONLY && !stale) {
      console.log(`${prefix} SKIP  ${tenant.slug.padEnd(28)} marker=${currentMarker} vars=${varCount}`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      const action = stale ? "WOULD REFRESH" : "WOULD REFRESH (already current)";
      console.log(`${prefix} ${action.padEnd(22)} ${tenant.slug.padEnd(28)} marker=${currentMarker} vars=${varCount}`);
      refreshed++;
      continue;
    }

    try {
      const snapshot = await writeTenantAppearanceSnapshot(tenant.id);
      const newVarCount = snapshot?.resolvedCssVars
        ? Object.keys(snapshot.resolvedCssVars).length
        : 0;
      console.log(
        `${prefix} REFRESHED  ${tenant.slug.padEnd(28)} ` +
        `${currentMarker} → ${snapshot.debugSnapshotMarker}  ` +
        `vars: ${varCount} → ${newVarCount}`
      );
      refreshed++;
    } catch (err) {
      console.error(`${prefix} FAILED     ${tenant.slug.padEnd(28)} ${err.message}`);
      failures.push({ slug: tenant.slug, error: err.message });
      failed++;
    }

    // Small delay to avoid overwhelming the DB on large fleets
    if (i < tenants.length - 1) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("Summary:");
  if (!DRY_RUN) {
    console.log(`  Refreshed: ${refreshed}`);
    console.log(`  Skipped:   ${skipped}`);
    console.log(`  Failed:    ${failed}`);
  } else {
    console.log(`  Would refresh: ${refreshed}`);
    console.log(`  Would skip:    ${skipped}`);
  }

  if (failures.length > 0) {
    console.error("\nFailed tenants:");
    for (const f of failures) {
      console.error(`  ${f.slug}: ${f.error}`);
    }
    process.exit(1);
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
