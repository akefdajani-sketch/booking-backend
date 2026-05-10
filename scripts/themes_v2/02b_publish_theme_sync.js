#!/usr/bin/env node
/**
 * scripts/themes_v2/02b_publish_theme_sync.js
 * ─────────────────────────────────────────────────────────────────────────
 * THEMES-V2 Phase 5.1 — flip is_published FALSE → TRUE for previously
 * inserted platform_themes rows, with a fresh diff re-run as the gate.
 *
 * The two-gate model:
 *   Gate 1 (Script 1 + 2):  audit-clean → INSERT (possibly unpublished)
 *   Gate 2 (this script):   re-run audit math against current DB state →
 *                           publish only if zero diffs across all affected
 *                           tenants and zero diffs on protected tenants.
 *
 * Why a separate script:
 *   * Inserts and publishes have different risk profiles and warrant
 *     independent audit trails.
 *   * Gate 2 re-validates against CURRENT state (not the original audit
 *     sidecar), catching drift in tenant brand_overrides / branding
 *     between Script 2 and publish time.
 *
 * Per-row workflow:
 *   1. Fetch existing row from platform_themes.
 *   2. If missing → ERROR (run Script 2 first).
 *   3. If is_published already TRUE → NO_OP (idempotent).
 *   4. Fetch tenants with theme_key = <key>. For each, compose
 *        CURRENT  = resolved vars with row UNPUBLISHED (resolver ignores)
 *        SIMULATED = resolved vars with row's tokens injected as if PUBLISHED
 *      and diff (using _lib's normalized comparator).
 *   5. If any protected tenant diffs → SKIP_DUE_TO_PROTECTED_DIFF (loud).
 *      If any tenant diffs → SKIP_DUE_TO_DIFF.
 *      Otherwise → PUBLISH (UPDATE is_published=TRUE).
 *   6. Refresh affected tenants' snapshots after a successful publish.
 *
 * Defaults to dry-run. Pass --apply to write.
 *
 * Usage:
 *   node scripts/themes_v2/02b_publish_theme_sync.js --rows=boutique-beauty
 *   node scripts/themes_v2/02b_publish_theme_sync.js --rows=classic --apply
 */

"use strict";

try { require("dotenv").config(); } catch { /* dotenv optional */ }

const fs = require("fs");
const path = require("path");

const db = require("../../db");
const { writeTenantAppearanceSnapshot } = require("../../theme/resolveTenantAppearanceSnapshot");
const {
  REJECTED_KEYS,
  composeResolvedCssVars,
  diffMaps,
} = require("./_lib");

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}

const ROWS_RAW = getArg("--rows", null);
const APPLY = args.includes("--apply");
const PROTECTED_RAW = getArg("--protected-ids", "3,21,33");

if (!ROWS_RAW) {
  console.error("Required: --rows=<keys>  (comma-separated, e.g. --rows=boutique-beauty)");
  process.exit(1);
}

const REQUESTED = ROWS_RAW.split(",").map((s) => s.trim()).filter(Boolean);
const REJECTED_REQUESTED = REQUESTED.filter((k) => REJECTED_KEYS.includes(k));
const TARGETS = REQUESTED.filter((k) => !REJECTED_KEYS.includes(k));

const PROTECTED_IDS = new Set(
  PROTECTED_RAW.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
);

// ── Per-row evaluation ───────────────────────────────────────────────────
async function evaluateRow(key) {
  const result = { key };

  const cur = await db.query(
    `SELECT key, name, version, is_published, layout_key, tokens_json
       FROM platform_themes WHERE key = $1`,
    [key]
  );
  const existing = cur.rows[0];
  if (!existing) {
    result.action = "ERROR";
    result.reason = "row not found in platform_themes (run Script 2 first)";
    return result;
  }
  result.existing = {
    is_published: existing.is_published,
    layout_key: existing.layout_key,
    version: existing.version,
    tokenCount: Object.keys(existing.tokens_json || {}).length,
  };

  if (existing.is_published) {
    result.action = "NO_OP";
    result.reason = "is_published already TRUE";
    return result;
  }

  const tenantsQ = await db.query(
    `SELECT id, slug, theme_key, publish_status,
            brand_overrides_json, branding, branding_published,
            theme_schema_published_json
       FROM tenants WHERE theme_key = $1 ORDER BY id`,
    [key]
  );
  const affected = tenantsQ.rows;
  result.affectedCount = affected.length;
  result.affectedIds = affected.map((t) => t.id);
  result.protectedInSet = affected
    .filter((t) => PROTECTED_IDS.has(t.id))
    .map((t) => ({ id: t.id, slug: t.slug }));

  const tenantDiffs = [];
  for (const t of affected) {
    // CURRENT: row exists but unpublished → resolver's LEFT JOIN ignores it.
    const tenantCurrent = {
      ...t,
      platform_tokens_json: null,
      platform_theme_layout_key: null,
    };
    const currentVars = composeResolvedCssVars(tenantCurrent, undefined);

    // SIMULATED: row published → resolver picks up tokens_json + layout_key.
    const tenantSimulated = {
      ...t,
      platform_tokens_json: existing.tokens_json,
      platform_theme_layout_key: existing.layout_key,
    };
    const simulatedVars = composeResolvedCssVars(tenantSimulated, existing.tokens_json);

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
  result.tenantDiffs = tenantDiffs;

  const protectedDiffs = tenantDiffs.filter((d) => d.isProtected);
  if (protectedDiffs.length > 0) {
    result.action = "SKIP_DUE_TO_PROTECTED_DIFF";
    result.reason = `${protectedDiffs.length} protected tenant(s) would diff — hard stop`;
    return result;
  }
  if (tenantDiffs.length > 0) {
    result.action = "SKIP_DUE_TO_DIFF";
    result.reason = `${tenantDiffs.length} tenant(s) would diff`;
    return result;
  }

  result.action = "PUBLISH";
  return result;
}

async function publishRow(key) {
  const r = await db.query(
    `UPDATE platform_themes
        SET is_published = TRUE,
            version = version + 1
      WHERE key = $1
        AND is_published = FALSE`,
    [key]
  );
  return r.rowCount > 0;
}

async function refreshTenants(idsArr) {
  const refreshes = [];
  for (const id of idsArr) {
    if (APPLY) {
      try {
        await writeTenantAppearanceSnapshot(id);
        refreshes.push({ tenantId: id, ok: true });
      } catch (err) {
        refreshes.push({ tenantId: id, ok: false, error: err.message });
      }
    } else {
      refreshes.push({ tenantId: id, ok: null, mode: "dry-run" });
    }
  }
  return refreshes;
}

// ── Main ─────────────────────────────────────────────────────────────────
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  const HR = "═".repeat(76);
  const SR = "─".repeat(76);

  console.log(HR);
  console.log("THEMES-V2 Phase 5.1 — Publish Theme Sync (02b)");
  console.log(HR);
  console.log(`Mode:        ${APPLY ? "APPLY (writes enabled)" : "DRY-RUN (no writes)"}`);
  console.log(`Targets:     ${TARGETS.join(", ") || "(none)"}`);
  if (REJECTED_REQUESTED.length > 0) {
    console.log(`Refused:     ${REJECTED_REQUESTED.join(", ")} (Phase 5.1 hardcoded out)`);
  }
  console.log(`Protected:   ${[...PROTECTED_IDS].join(", ")}`);
  console.log("");

  console.log(SR);
  console.log("Per-row evaluation");
  console.log(SR);

  const evaluated = [];
  for (const key of TARGETS) {
    const r = await evaluateRow(key);
    evaluated.push(r);

    const verb = APPLY ? "" : "would ";
    console.log(`▶ ${key}: ${verb}${r.action}` + (r.reason ? `  (${r.reason})` : ""));
    if (r.existing) {
      console.log(`    existing: pub=${r.existing.is_published} layout=${r.existing.layout_key} ` +
        `tokens=${r.existing.tokenCount} version=${r.existing.version}`);
    }
    if (r.affectedCount !== undefined) {
      console.log(`    affected: ${r.affectedCount} tenant(s)` +
        (r.protectedInSet && r.protectedInSet.length > 0
          ? `  ⚠ protected in set: ${r.protectedInSet.map((t) => `${t.id}:${t.slug}`).join(", ")}`
          : ""));
    }
    if (r.tenantDiffs && r.tenantDiffs.length > 0) {
      for (const td of r.tenantDiffs) {
        const tag = td.isProtected ? " ⚠ PROTECTED" : "";
        console.log(`      id=${td.id} ${td.slug}${tag}  (${td.diffCount} diff${td.diffCount === 1 ? "" : "s"})`);
        const shown = td.diffs.slice(0, 8);
        for (const d of shown) {
          const tags = [];
          if (d.blocked) tags.push("BLOCKED");
          if (d.addition) tags.push("+ADDITION");
          const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
          console.log(`          ${pad(d.key, 30)} : ${String(d.current).padEnd(28).slice(0, 28)} → ${d.simulated}${tagStr}`);
        }
        if (td.diffs.length > 8) console.log(`          … (+${td.diffs.length - 8} more in log)`);
      }
    }
  }
  console.log("");

  // Apply
  console.log(SR);
  console.log("Apply queue");
  console.log(SR);
  const actions = [];
  const refreshIds = new Set();
  for (const r of evaluated) {
    if (r.action !== "PUBLISH") continue;
    if (APPLY) {
      const ok = await publishRow(r.key);
      actions.push({ key: r.key, action: "PUBLISH", ok });
      console.log(`  ${pad(r.key, 22)} PUBLISH  ${ok ? "ok" : "skipped (already published?)"}`);
    } else {
      actions.push({ key: r.key, action: "PUBLISH", ok: null, mode: "dry-run" });
      console.log(`  ${pad(r.key, 22)} would PUBLISH`);
    }
    for (const id of r.affectedIds || []) refreshIds.add(id);
  }
  if (actions.length === 0) console.log("  (no rows cleared for publish)");
  console.log("");

  const refreshes = await refreshTenants([...refreshIds].sort((a, b) => a - b));
  console.log(SR);
  console.log(`Snapshot refreshes (${APPLY ? "executed" : "would execute"})`);
  console.log(SR);
  if (refreshes.length === 0) console.log("  (none)");
  for (const r of refreshes) {
    const status = r.ok === true ? "ok" : r.ok === false ? `FAIL: ${r.error}` : "(dry-run)";
    console.log(`  tenant ${r.tenantId}  ${status}`);
  }
  console.log("");

  // Log
  const log = {
    timestamp: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    requested: REQUESTED,
    refused: REJECTED_REQUESTED,
    targets: TARGETS,
    protectedIds: [...PROTECTED_IDS],
    evaluated,
    actions,
    refreshes,
  };
  const auditDir = path.join(__dirname, ".audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const safeTs = log.timestamp.replace(/[:.]/g, "-");
  const logName = APPLY ? `02b_publish_${safeTs}.json` : `02b_publish_${safeTs}_dryrun.json`;
  const logPath = path.join(auditDir, logName);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

  console.log(HR);
  console.log("Summary");
  console.log(HR);
  const counts = {};
  for (const e of evaluated) counts[e.action] = (counts[e.action] || 0) + 1;
  if (Object.keys(counts).length === 0) console.log("  (no rows evaluated)");
  for (const [act, n] of Object.entries(counts)) console.log(`  ${pad(act, 30)} ${n}`);
  console.log("");
  console.log(`Log: ${logPath}`);
  if (!APPLY) {
    console.log("");
    console.log("This was a dry-run. Re-run with --apply to publish.");
  }

  const refreshFailed = refreshes.some((r) => r.ok === false);
  await safeShutdown(refreshFailed ? 1 : 0);
}

async function safeShutdown(code) {
  try { await db.pool.end(); } catch { /* ignore */ }
  process.exit(code);
}

main().catch(async (err) => {
  console.error("Fatal:", err && err.stack ? err.stack : err);
  await safeShutdown(1);
});
