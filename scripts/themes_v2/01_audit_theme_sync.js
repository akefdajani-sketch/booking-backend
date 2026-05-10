#!/usr/bin/env node
/**
 * scripts/themes_v2/01_audit_theme_sync.js
 * ─────────────────────────────────────────────────────────────────────────
 * THEMES-V2 Phase 5.1 — read-only audit of platform_themes vs.
 * theme/contractThemeRegistry.js.
 *
 * For each candidate theme key (default: classic, premium, minimal,
 * boutique-beauty — premium-hospitality is hardcoded out, see Birdie hold):
 *
 *   1. Decide row state in platform_themes:
 *        ROW_MISSING                   — no row, fresh insert path
 *        ROW_PRESENT_EMPTY_TOKENS      — row exists, tokens_json is {} or null
 *        ROW_PRESENT_NON_EMPTY_TOKENS  — row exists with tokens; never overwrite
 *
 *   2. Build candidate tokens_json from contractThemeRegistry by mapping
 *      contract color.* values into the legacy --bf-* slots that
 *      buildResolvedCssVars consumes.
 *
 *   3. Find tenants with theme_key = <key>. For each, run a per-tenant
 *      dry-run: compose resolvedCssVars twice (current platformTokens vs.
 *      candidate platformTokens with is_published=TRUE assumed) and diff
 *      the resolved var maps.
 *
 *   4. Recommend per row:
 *        NO_TENANTS_AFFECTED            — no tenants on this key (boutique-beauty)
 *        SAFE_INSERT                    — zero diff for every affected tenant
 *        SKIP_DUE_TO_DIFF               — at least one non-protected tenant diffs
 *        SKIP_DUE_TO_PROTECTED_DIFF     — Birdie / Al-Razi / aqababooking diffs (LOUD)
 *        SKIP_ROW_HAS_EXISTING_TOKENS   — row exists with tokens; out of scope
 *
 * Diff semantics (important):
 *   The audit assumes the inserted row is published (is_published=TRUE) so
 *   the resolver's LEFT JOIN picks it up. SAFE_INSERT therefore means
 *   "safe to insert AND safe to publish". SKIP_DUE_TO_DIFF still allows
 *   inserting at is_published=FALSE (the resolver ignores unpublished rows),
 *   but the publish step must re-evaluate. Script 2 uses this distinction
 *   to apply ak's split rule (boutique-beauty=TRUE, others=FALSE).
 *
 * Usage:
 *   node scripts/themes_v2/01_audit_theme_sync.js
 *   node scripts/themes_v2/01_audit_theme_sync.js --rows=boutique-beauty
 *   node scripts/themes_v2/01_audit_theme_sync.js --protected-ids=3,21,33
 *   node scripts/themes_v2/01_audit_theme_sync.js --json
 *
 * Output:
 *   .audit/01_audit_<ISO>.json    — timestamped sidecar
 *   .audit/latest.json            — copy of the most-recent sidecar
 *   stdout                         — human table (suppressed by --json)
 *
 * Exit codes:
 *   0  audit completed (recommendations may include SKIPs — that is not failure)
 *   1  audit could not run (DB error, missing registry, etc.)
 */

"use strict";

try { require("dotenv").config(); } catch { /* dotenv optional in prod */ }

const fs = require("fs");
const path = require("path");

const db = require("../../db");
const { toObj } = require("../../theme/resolveTenantAppearanceSnapshot");
const {
  CONTRACT_REGISTRY,
  REJECTED_KEYS,
  BLOCKED_BF_KEYS,
  buildCandidateRow,
  composeResolvedCssVars,
  diffMaps,
} = require("./_lib");

// ── CLI flags ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name, fallback) {
  // Accepts --name=value or --name value
  const eqMatch = args.find((a) => a.startsWith(`${name}=`));
  if (eqMatch) return eqMatch.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}

const ROWS_RAW = getArg("--rows", "classic,premium,minimal,boutique-beauty");
const PROTECTED_RAW = getArg("--protected-ids", "3,21,33");
const JSON_ONLY = args.includes("--json");

const REQUESTED_KEYS = ROWS_RAW.split(",").map((s) => s.trim()).filter(Boolean);

// REJECTED_KEYS comes from _lib (premium-hospitality is hardcoded out for Phase 5.1).
const TARGET_KEYS = REQUESTED_KEYS.filter((k) => !REJECTED_KEYS.includes(k));
const REJECTED_REQUESTED = REQUESTED_KEYS.filter((k) => REJECTED_KEYS.includes(k));

const PROTECTED_IDS = new Set(
  PROTECTED_RAW.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
);

// All diff/normalization/composition helpers live in ./_lib.js — imported above.

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  // Inventory: platform_themes
  // Live schema (per routes/adminThemes.js) is: key, name, version, is_published,
  // layout_key, tokens_json. Migration 013 referenced is_active but the column
  // does not exist on the live table — Phase 5.1.5 schema-capture migration TODO.
  const platformQ = await db.query(
    `SELECT key, name, version, is_published, layout_key, tokens_json
       FROM platform_themes
      ORDER BY key`
  );
  const platformThemes = platformQ.rows;
  const platformByKey = new Map(platformThemes.map((r) => [r.key, r]));

  // Inventory: tenant theme distribution (live; do not trust migration 067 numbers)
  const distQ = await db.query(
    `SELECT theme_key,
            COUNT(*)::int AS n,
            array_agg(id ORDER BY id)   AS ids,
            array_agg(slug ORDER BY id) AS slugs
       FROM tenants
      GROUP BY theme_key
      ORDER BY theme_key`
  );
  const tenantDistribution = distQ.rows;

  // Protected tenant detail
  const protectedQ = await db.query(
    `SELECT id, slug, theme_key, publish_status
       FROM tenants
      WHERE id = ANY($1::int[])
      ORDER BY id`,
    [[...PROTECTED_IDS]]
  );
  const protectedTenants = protectedQ.rows;

  // Per-row evaluation
  const rowResults = [];

  for (const themeKey of TARGET_KEYS) {
    const candidate = buildCandidateRow(themeKey);
    if (!candidate) {
      rowResults.push({
        key: themeKey,
        recommendation: "ERROR_NOT_IN_REGISTRY",
        rowState: null,
        notes: `Theme key '${themeKey}' is not in theme/contractThemeRegistry.js`,
      });
      continue;
    }

    const existing = platformByKey.get(themeKey) || null;
    const existingTokens = existing ? toObj(existing.tokens_json) : null;
    const existingTokenCount = existingTokens ? Object.keys(existingTokens).length : 0;

    let rowState;
    if (!existing) rowState = "ROW_MISSING";
    else if (existingTokenCount === 0) rowState = "ROW_PRESENT_EMPTY_TOKENS";
    else rowState = "ROW_PRESENT_NON_EMPTY_TOKENS";

    if (rowState === "ROW_PRESENT_NON_EMPTY_TOKENS") {
      rowResults.push({
        key: themeKey,
        recommendation: "SKIP_ROW_HAS_EXISTING_TOKENS",
        rowState,
        existingRow: {
          name: existing.name,
          version: existing.version,
          is_published: existing.is_published,
          layout_key: existing.layout_key,
          tokens_json: existingTokens,
          tokenCount: existingTokenCount,
        },
        candidate,
        notes:
          "Phase 5.1 never overwrites a non-empty tokens_json. Re-baselining " +
          "existing rows is a separate phase with its own risk profile.",
      });
      continue;
    }

    // Affected tenants for this theme key
    const tenantsQ = await db.query(
      `SELECT id, slug, theme_key, publish_status,
              brand_overrides_json,
              branding,
              branding_published,
              theme_schema_published_json
         FROM tenants
        WHERE theme_key = $1
        ORDER BY id`,
      [themeKey]
    );
    const affected = tenantsQ.rows;

    if (affected.length === 0) {
      rowResults.push({
        key: themeKey,
        recommendation: "NO_TENANTS_AFFECTED",
        rowState,
        candidate,
        affectedCount: 0,
        affectedIds: [],
        protectedInSet: [],
        tenantDiffs: [],
      });
      continue;
    }

    // Current platform_themes state for the join (only published rows count)
    const currentPlatformTokens =
      existing && existing.is_published ? existingTokens : null;
    const currentPlatformLayoutKey =
      existing && existing.is_published ? existing.layout_key : null;

    const tenantDiffs = [];
    for (const t of affected) {
      const tenantRow = {
        ...t,
        platform_tokens_json: currentPlatformTokens,
        platform_theme_layout_key: currentPlatformLayoutKey,
      };
      const currentVars = composeResolvedCssVars(tenantRow, undefined);
      // SIMULATED: the inserted row is published → resolver picks up candidate tokens
      const simulatedVars = composeResolvedCssVars(tenantRow, candidate.tokens_json);
      const diffs = diffMaps(currentVars, simulatedVars);
      if (diffs.length > 0) {
        tenantDiffs.push({
          id: t.id,
          slug: t.slug,
          isProtected: PROTECTED_IDS.has(t.id),
          diffCount: diffs.length,
          diffs,
        });
      }
    }

    const protectedDiffs = tenantDiffs.filter((d) => d.isProtected);
    const recommendation =
      protectedDiffs.length > 0
        ? "SKIP_DUE_TO_PROTECTED_DIFF"
        : tenantDiffs.length > 0
        ? "SKIP_DUE_TO_DIFF"
        : "SAFE_INSERT";

    rowResults.push({
      key: themeKey,
      recommendation,
      rowState,
      candidate,
      affectedCount: affected.length,
      affectedIds: affected.map((t) => t.id),
      protectedInSet: affected
        .filter((t) => PROTECTED_IDS.has(t.id))
        .map((t) => ({ id: t.id, slug: t.slug })),
      tenantDiffs,
      notes:
        recommendation === "SKIP_DUE_TO_DIFF"
          ? "Inserting at is_published=FALSE remains safe (resolver ignores " +
            "unpublished rows). Publishing requires re-evaluation."
          : recommendation === "SKIP_DUE_TO_PROTECTED_DIFF"
          ? "Protected tenant resolved-vars would change. Hard stop."
          : recommendation === "SAFE_INSERT"
          ? "Zero resolvedCssVars diff for every affected tenant. Safe to " +
            "insert and (eventually) publish."
          : "No tenants currently use this theme key.",
    });
  }

  // Sidecar
  const sidecar = {
    timestamp: new Date().toISOString(),
    phase: "5.1",
    requestedKeys: REQUESTED_KEYS,
    targetKeys: TARGET_KEYS,
    rejectedKeys: REJECTED_KEYS,
    rejectedRequested: REJECTED_REQUESTED,
    protectedIds: [...PROTECTED_IDS],
    protectedTenants,
    platformThemesInventory: platformThemes.map((r) => ({
      key: r.key,
      name: r.name,
      version: r.version,
      is_published: r.is_published,
      layout_key: r.layout_key,
      tokenCount: Object.keys(toObj(r.tokens_json)).length,
      tokens_json: toObj(r.tokens_json),
    })),
    tenantDistribution,
    rows: rowResults,
  };

  // Write sidecar + latest copy
  const auditDir = path.join(__dirname, ".audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const safeTs = sidecar.timestamp.replace(/[:.]/g, "-");
  const outPath = path.join(auditDir, `01_audit_${safeTs}.json`);
  const latestPath = path.join(auditDir, "latest.json");
  fs.writeFileSync(outPath, JSON.stringify(sidecar, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(sidecar, null, 2));

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(sidecar, null, 2) + "\n");
    await safeShutdown(0);
    return;
  }

  // Human output
  printHumanReport(sidecar, outPath, latestPath);
  await safeShutdown(0);
}

// ── Human output ────────────────────────────────────────────────────────
function pad(s, n) {
  s = String(s);
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}
function padNum(n, w) {
  const s = String(n);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function printHumanReport(sidecar, outPath, latestPath) {
  const HR = "═".repeat(76);
  const SR = "─".repeat(76);

  console.log(HR);
  console.log("THEMES-V2 Phase 5.1 — Theme Sync Audit (READ-ONLY)");
  console.log(HR);
  console.log(`Timestamp:       ${sidecar.timestamp}`);
  console.log(`Target keys:     ${sidecar.targetKeys.join(", ")}`);
  if (sidecar.rejectedRequested.length > 0) {
    console.log(`Rejected req'd:  ${sidecar.rejectedRequested.join(", ")} (Phase 5.1 hardcoded out)`);
  }
  console.log(`Protected IDs:   ${sidecar.protectedIds.join(", ")}`);
  console.log("");

  // Protected tenant detail
  console.log(SR);
  console.log("Protected tenants (current state)");
  console.log(SR);
  if (sidecar.protectedTenants.length === 0) {
    console.log("  ⚠  none of the protected IDs exist in the tenants table");
  } else {
    for (const t of sidecar.protectedTenants) {
      console.log(
        `  id=${padNum(t.id, 3)}  slug=${pad(t.slug, 20)}  ` +
        `theme_key=${pad(t.theme_key, 22)}  publish=${t.publish_status}`
      );
    }
  }
  console.log("");

  // platform_themes inventory
  console.log(SR);
  console.log("platform_themes inventory");
  console.log(SR);
  console.log(
    `  ${pad("key", 22)} ${pad("name", 22)} ${pad("layout_key", 14)} pub  tokens`
  );
  console.log(`  ${"-".repeat(22)} ${"-".repeat(22)} ${"-".repeat(14)} ---  ------`);
  for (const r of sidecar.platformThemesInventory) {
    console.log(
      `  ${pad(r.key, 22)} ${pad(r.name || "", 22)} ${pad(r.layout_key || "", 14)} ` +
      `${r.is_published ? " Y " : " n "}  ${padNum(r.tokenCount, 5)}`
    );
  }
  console.log("");

  // Tenant distribution
  console.log(SR);
  console.log("Tenant theme_key distribution (LIVE)");
  console.log(SR);
  console.log(`  ${pad("theme_key", 22)} count  tenants (id:slug)`);
  console.log(`  ${"-".repeat(22)} -----  -----------------`);
  for (const r of sidecar.tenantDistribution) {
    const samples = r.ids
      .map((id, i) => `${id}:${r.slugs[i]}`)
      .slice(0, 6);
    const moreSuffix = r.ids.length > 6 ? `, …(+${r.ids.length - 6})` : "";
    console.log(
      `  ${pad(r.theme_key || "(null)", 22)} ${padNum(r.n, 5)}  ${samples.join(", ")}${moreSuffix}`
    );
  }
  console.log("");

  // Per-row results
  console.log(HR);
  console.log("Per-row recommendations");
  console.log(HR);

  for (const r of sidecar.rows) {
    console.log("");
    console.log(`▶ ${r.key}`);
    console.log(`  recommendation: ${r.recommendation}`);
    console.log(`  rowState:       ${r.rowState || "(n/a)"}`);
    if (r.affectedCount !== undefined) {
      console.log(`  affected:       ${r.affectedCount} tenant(s)`);
      if (r.protectedInSet && r.protectedInSet.length > 0) {
        const ps = r.protectedInSet.map((t) => `${t.id}:${t.slug}`).join(", ");
        console.log(`  protected:      ${ps}  ⚠ in affected set`);
      }
    }
    if (r.notes) console.log(`  note:           ${r.notes}`);

    if (r.recommendation === "SKIP_ROW_HAS_EXISTING_TOKENS") {
      console.log(`  existing row:   v${r.existingRow.version}, ` +
        `published=${r.existingRow.is_published}, ` +
        `layout=${r.existingRow.layout_key}, ` +
        `tokens=${r.existingRow.tokenCount}`);
      console.log(`  existing tokens_json:`);
      const ek = Object.keys(r.existingRow.tokens_json).sort();
      for (const k of ek) {
        console.log(`    ${pad(k, 36)} = ${r.existingRow.tokens_json[k]}`);
      }
    }

    if (r.candidate) {
      const cn = Object.keys(r.candidate.tokens_json).length;
      console.log(`  candidate row:  key=${r.candidate.key}  ` +
        `name="${r.candidate.name}"  layout=${r.candidate.layout_key}  tokens=${cn}`);
    }

    if (r.tenantDiffs && r.tenantDiffs.length > 0) {
      console.log(`  tenant diffs:   ${r.tenantDiffs.length} tenant(s) would change`);
      for (const td of r.tenantDiffs) {
        const tag = td.isProtected ? " ⚠ PROTECTED" : "";
        console.log(`    ─ id=${td.id} slug=${td.slug}${tag}  (${td.diffCount} var diff${td.diffCount === 1 ? "" : "s"})`);
        // Limit to 12 vars per tenant in stdout — full detail in sidecar.
        const shown = td.diffs.slice(0, 12);
        for (const d of shown) {
          const tags = [];
          if (d.blocked) tags.push("BLOCKED — should not appear");
          if (d.addition) tags.push("+ADDITION");
          const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
          console.log(
            `        ${pad(d.key, 32)} : ${String(d.current).padEnd(28).slice(0, 28)} → ${d.simulated}${tagStr}`
          );
        }
        if (td.diffs.length > 12) {
          console.log(`        … (+${td.diffs.length - 12} more in sidecar)`);
        }
      }
    }
  }

  // Summary
  console.log("");
  console.log(HR);
  console.log("Summary");
  console.log(HR);
  const counts = {};
  for (const r of sidecar.rows) {
    counts[r.recommendation] = (counts[r.recommendation] || 0) + 1;
  }
  for (const [rec, n] of Object.entries(counts)) {
    console.log(`  ${pad(rec, 32)} ${n}`);
  }
  console.log("");
  console.log(`Sidecar:  ${outPath}`);
  console.log(`Latest:   ${latestPath}`);
  console.log("");
  console.log("Next step: review SAFE_INSERT and SKIP_* rows above. If happy,");
  console.log("run Script 2 with --from-audit=latest.json to apply.");
}

async function safeShutdown(code) {
  try { await db.pool.end(); } catch { /* ignore */ }
  process.exit(code);
}

main().catch(async (err) => {
  console.error("Fatal:", err && err.stack ? err.stack : err);
  await safeShutdown(1);
});
