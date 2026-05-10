#!/usr/bin/env node
/**
 * scripts/themes_v2/02_apply_theme_sync.js
 * ─────────────────────────────────────────────────────────────────────────
 * THEMES-V2 Phase 5.1 — apply audit-cleared theme rows to platform_themes.
 *
 * Reads `.audit/<file>` produced by 01_audit_theme_sync.js. For each row
 * with recommendation in {SAFE_INSERT, NO_TENANTS_AFFECTED}:
 *
 *   1. Re-fetch the existing row from platform_themes (DB may have moved
 *      since the audit was written).
 *   2. Decide action:
 *        INSERT  — row missing
 *        UPDATE  — row exists with empty/null tokens_json
 *        NO_OP   — row exists with tokens_json byte-equal to candidate
 *        SKIP    — row exists with non-empty divergent tokens_json
 *                  (audit became stale; user must re-audit)
 *   3. is_published = (affectedCount === 0). Per ak's rule: only safe-by-
 *      definition rows publish at insert; rows with affected tenants stay
 *      unpublished pending 02b.
 *   4. Refresh affected tenants' snapshots (reuses
 *      writeTenantAppearanceSnapshot from theme/resolveTenantAppearanceSnapshot).
 *   5. Write a deploy log to .audit/02_apply_<ISO>.json.
 *
 * Defaults to dry-run. Pass --apply to write.
 *
 * Usage:
 *   node scripts/themes_v2/02_apply_theme_sync.js                        # dry-run, all cleared rows
 *   node scripts/themes_v2/02_apply_theme_sync.js --apply                # write
 *   node scripts/themes_v2/02_apply_theme_sync.js --rows=boutique-beauty # subset
 *   node scripts/themes_v2/02_apply_theme_sync.js --from-audit=01_audit_2026-05-10T17-25-39-898Z.json
 */

"use strict";

try { require("dotenv").config(); } catch { /* dotenv optional */ }

const fs = require("fs");
const path = require("path");

const db = require("../../db");
const { writeTenantAppearanceSnapshot } = require("../../theme/resolveTenantAppearanceSnapshot");
const { tokensEqual, REJECTED_KEYS } = require("./_lib");

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}

const FROM_AUDIT = getArg("--from-audit", "latest.json");
const APPLY = args.includes("--apply");
const ROWS_FILTER_RAW = getArg("--rows", null);
const ROWS_FILTER = ROWS_FILTER_RAW
  ? new Set(ROWS_FILTER_RAW.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const MAX_AGE_MIN = parseInt(getArg("--max-audit-age-min", "60"), 10);

const ALLOWED_RECOMMENDATIONS = new Set(["SAFE_INSERT", "NO_TENANTS_AFFECTED"]);

// ── Load & validate sidecar ──────────────────────────────────────────────
const auditDir = path.join(__dirname, ".audit");
const auditPath = path.isAbsolute(FROM_AUDIT)
  ? FROM_AUDIT
  : path.join(auditDir, FROM_AUDIT);

let sidecar;
try {
  sidecar = JSON.parse(fs.readFileSync(auditPath, "utf8"));
} catch (err) {
  console.error(`Could not read audit sidecar at ${auditPath}: ${err.message}`);
  process.exit(1);
}

function refuse(msg) {
  console.error(`Refusing to apply: ${msg}`);
  process.exit(1);
}

if (sidecar.phase !== "5.1") refuse(`sidecar.phase = ${sidecar.phase} (expected "5.1")`);
const auditAgeMin = (Date.now() - new Date(sidecar.timestamp).getTime()) / 60000;
if (!Number.isFinite(auditAgeMin)) refuse("invalid sidecar.timestamp");
if (auditAgeMin > MAX_AGE_MIN) {
  refuse(`audit is ${auditAgeMin.toFixed(1)} min old (max ${MAX_AGE_MIN}). Re-run Script 1 or pass --max-audit-age-min=N.`);
}
if (!Array.isArray(sidecar.rows)) refuse(`sidecar.rows missing/not an array`);
if (!Array.isArray(sidecar.rejectedKeys) || !sidecar.rejectedKeys.includes("premium-hospitality")) {
  refuse("sidecar.rejectedKeys missing or doesn't include premium-hospitality");
}

// ── Filter & queue ───────────────────────────────────────────────────────
const queue = [];
const skipped = [];
for (const row of sidecar.rows) {
  if (REJECTED_KEYS.includes(row.key)) {
    skipped.push({ key: row.key, reason: "key in REJECTED_KEYS (Phase 5.1 hardcoded refusal)" });
    continue;
  }
  if (!ALLOWED_RECOMMENDATIONS.has(row.recommendation)) {
    skipped.push({ key: row.key, reason: `audit recommendation: ${row.recommendation}` });
    continue;
  }
  if (ROWS_FILTER && !ROWS_FILTER.has(row.key)) {
    skipped.push({ key: row.key, reason: `not in --rows=${ROWS_FILTER_RAW}` });
    continue;
  }
  if (!row.candidate || !row.candidate.tokens_json) {
    skipped.push({ key: row.key, reason: "no candidate row in sidecar" });
    continue;
  }
  queue.push(row);
}

// ── Per-row apply ────────────────────────────────────────────────────────
async function applyRow(row) {
  const candidate = row.candidate;
  const targetIsPublished = (row.affectedCount || 0) === 0;
  const result = {
    key: row.key,
    candidateName: candidate.name,
    candidateLayoutKey: candidate.layout_key,
    candidateTokenCount: Object.keys(candidate.tokens_json || {}).length,
    affectedCount: row.affectedCount || 0,
    affectedIds: row.affectedIds || [],
    target_is_published: targetIsPublished,
  };

  // Re-fetch from DB
  const cur = await db.query(
    `SELECT key, name, version, is_published, layout_key, tokens_json
       FROM platform_themes WHERE key = $1`,
    [row.key]
  );
  const existing = cur.rows[0] || null;

  if (!existing) {
    result.action = "INSERT";
    if (APPLY) {
      // ON CONFLICT DO NOTHING for race safety; we re-verify below.
      await db.query(
        `INSERT INTO platform_themes (key, name, layout_key, tokens_json, is_published)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (key) DO NOTHING`,
        [
          candidate.key,
          candidate.name,
          candidate.layout_key,
          JSON.stringify(candidate.tokens_json),
          targetIsPublished,
        ]
      );
      const verify = await db.query(
        `SELECT key, is_published, layout_key, tokens_json FROM platform_themes WHERE key = $1`,
        [row.key]
      );
      const v = verify.rows[0];
      result.verified = !!v;
      result.verified_is_published = v ? v.is_published : null;
      result.verified_tokens_match = v ? tokensEqual(v.tokens_json, candidate.tokens_json) : false;
    }
    return result;
  }

  // Existing row
  const existingTokens = existing.tokens_json || {};
  const existingIsEmpty = Object.keys(existingTokens).length === 0;

  if (tokensEqual(existingTokens, candidate.tokens_json)) {
    result.action = "NO_OP";
    result.reason = "row already exists with matching tokens_json (idempotent re-run)";
    result.existing_is_published = existing.is_published;
    return result;
  }

  if (existingIsEmpty) {
    result.action = "UPDATE";
    if (APPLY) {
      const r = await db.query(
        `UPDATE platform_themes
            SET name = $2,
                layout_key = $3,
                tokens_json = $4::jsonb,
                is_published = $5,
                version = version + 1
          WHERE key = $1
            AND (tokens_json IS NULL OR tokens_json = '{}'::jsonb)`,
        [
          row.key,
          candidate.name,
          candidate.layout_key,
          JSON.stringify(candidate.tokens_json),
          targetIsPublished,
        ]
      );
      if (r.rowCount === 0) {
        result.action = "SKIP";
        result.reason = "race: tokens_json became non-empty between fetch and update";
      } else {
        result.verified = true;
      }
    }
    return result;
  }

  result.action = "SKIP";
  result.reason = "row exists with non-empty tokens_json that does NOT match candidate; audit may be stale";
  result.existingTokens = existingTokens;
  result.existing_is_published = existing.is_published;
  return result;
}

// ── Snapshot refresh ─────────────────────────────────────────────────────
async function refreshAffectedTenants(applied) {
  const ids = new Set();
  for (const r of applied) {
    if (r.action === "INSERT" || r.action === "UPDATE") {
      for (const id of r.affectedIds || []) ids.add(id);
    }
  }
  const idsArr = [...ids].sort((a, b) => a - b);
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
  console.log("THEMES-V2 Phase 5.1 — Apply Theme Sync (02)");
  console.log(HR);
  console.log(`Mode:        ${APPLY ? "APPLY (writes enabled)" : "DRY-RUN (no writes)"}`);
  console.log(`Audit:       ${auditPath}`);
  console.log(`Audit ts:    ${sidecar.timestamp}  (${auditAgeMin.toFixed(1)} min ago)`);
  console.log(`Filter:      ${ROWS_FILTER_RAW || "(all audit-cleared rows)"}`);
  console.log(`Queue:       ${queue.length} row(s)`);
  console.log(`Skipped:     ${skipped.length} row(s)`);
  console.log("");

  if (skipped.length > 0) {
    console.log(SR);
    console.log("Skipped rows");
    console.log(SR);
    for (const s of skipped) {
      console.log(`  ${pad(s.key, 22)} ${s.reason}`);
    }
    console.log("");
  }

  console.log(SR);
  console.log("Apply queue");
  console.log(SR);
  if (queue.length === 0) {
    console.log("  (empty — nothing to apply)");
  }
  const applied = [];
  for (const row of queue) {
    const result = await applyRow(row);
    applied.push(result);
    const verb = APPLY ? "" : "would ";
    const tag = result.target_is_published !== undefined
      ? `  is_published=${result.target_is_published}`
      : "";
    const reason = result.reason ? `  (${result.reason})` : "";
    console.log(`  ${pad(row.key, 22)} ${verb}${result.action}${tag}${reason}`);
    if (result.action === "INSERT" || result.action === "UPDATE") {
      console.log(`    name=${result.candidateName}  layout=${result.candidateLayoutKey}  tokens=${result.candidateTokenCount}  affected=${result.affectedCount}`);
    }
  }
  console.log("");

  const refreshes = await refreshAffectedTenants(applied);
  console.log(SR);
  console.log(`Snapshot refreshes (${APPLY ? "executed" : "would execute"})`);
  console.log(SR);
  if (refreshes.length === 0) {
    console.log("  (none — no INSERT/UPDATE row had affected tenants)");
  } else {
    for (const r of refreshes) {
      const status =
        r.ok === true ? "ok"
        : r.ok === false ? `FAIL: ${r.error}`
        : "(dry-run)";
      console.log(`  tenant ${r.tenantId}  ${status}`);
    }
  }
  console.log("");

  // Deploy log
  const log = {
    timestamp: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    auditPath,
    auditTimestamp: sidecar.timestamp,
    rowsFilter: ROWS_FILTER ? [...ROWS_FILTER] : null,
    queue: queue.map((r) => r.key),
    skipped,
    applied,
    snapshotRefreshes: refreshes,
  };
  const safeTs = log.timestamp.replace(/[:.]/g, "-");
  const logName = APPLY ? `02_apply_${safeTs}.json` : `02_apply_${safeTs}_dryrun.json`;
  fs.mkdirSync(auditDir, { recursive: true });
  const logPath = path.join(auditDir, logName);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

  console.log(HR);
  console.log("Summary");
  console.log(HR);
  const counts = {};
  for (const a of applied) counts[a.action] = (counts[a.action] || 0) + 1;
  if (Object.keys(counts).length === 0) console.log("  (no actions)");
  for (const [act, n] of Object.entries(counts)) {
    console.log(`  ${pad(act, 20)} ${n}`);
  }
  console.log("");
  console.log(`Log: ${logPath}`);
  if (!APPLY) {
    console.log("");
    console.log("This was a dry-run. Re-run with --apply to write.");
  }

  // Exit nonzero if any apply attempt actually FAILED (FAIL refresh; SKIP and
  // NO_OP and dry-runs are not failures).
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
