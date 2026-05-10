#!/usr/bin/env node
/**
 * scripts/themes_v2/03_verify_post_sync.js
 * ─────────────────────────────────────────────────────────────────────────
 * THEMES-V2 Phase 5.1 — post-sync verification.
 *
 * What this checks:
 *   1. The two Phase 5.1 rows (boutique-beauty, minimal) are present and
 *      visible to the resolver's LEFT JOIN (is_published=TRUE).
 *   2. For every published tenant, the FRESH `resolveTenantAppearanceSnapshot`
 *      output's `resolvedCssVars` matches what's currently stored in
 *      `tenants.appearance_snapshot_published_json.resolvedCssVars`.
 *   3. PROTECTED tenants (default 3, 21, 33 — Birdie, Al-Razi, aqababooking)
 *      MUST diff zero. Any non-zero diff on a protected tenant is a hard
 *      fail (exit 1).
 *
 * Modes:
 *   default                      → compare fresh resolves vs live stored snapshots
 *   --baseline=<file>            → compare fresh resolves vs a captured baseline
 *                                  file (use when Script 3 was run BEFORE the
 *                                  apply step to capture pre-state)
 *   --write-baseline=<file>      → snapshot all tenants now and write to file;
 *                                  do nothing else (for capturing a baseline
 *                                  before a future apply phase)
 *
 * Diff comparator: `_lib.normalizeCssValue` + `_lib.diffMaps` (same
 * normalization as Script 1 — kills whitespace/hex/alpha noise).
 *
 * Exit codes:
 *   0  protected tenants all clean (other tenants may have informational diffs)
 *   1  any protected tenant diffs, or fatal error
 *
 * Usage:
 *   node scripts/themes_v2/03_verify_post_sync.js
 *   node scripts/themes_v2/03_verify_post_sync.js --write-baseline=.audit/baseline.json
 *   node scripts/themes_v2/03_verify_post_sync.js --baseline=.audit/baseline.json
 */

"use strict";

try { require("dotenv").config(); } catch { /* dotenv optional */ }

const fs = require("fs");
const path = require("path");

const db = require("../../db");
const { resolveTenantAppearanceSnapshot } = require("../../theme/resolveTenantAppearanceSnapshot");
const { diffMaps } = require("./_lib");

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}

const BASELINE_FILE = getArg("--baseline", null);
const WRITE_BASELINE = getArg("--write-baseline", null);
const PROTECTED_RAW = getArg("--protected-ids", "3,21,33");
const VERBOSE = args.includes("--verbose");

const PROTECTED_IDS = new Set(
  PROTECTED_RAW.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
);

const PHASE_5_1_KEYS = ["boutique-beauty", "minimal"];

// ── Utilities ────────────────────────────────────────────────────────────
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function toObj(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return {}; }
}

// ── Main flows ───────────────────────────────────────────────────────────
async function fetchPublishedTenants() {
  const q = await db.query(
    `SELECT id, slug, theme_key, publish_status,
            appearance_snapshot_published_json
       FROM tenants
      WHERE publish_status = 'published'
      ORDER BY id`
  );
  return q.rows;
}

async function checkPhase5_1Rows() {
  const q = await db.query(
    `SELECT key, is_published, layout_key,
            (SELECT COUNT(*) FROM jsonb_object_keys(tokens_json)) AS token_count
       FROM platform_themes WHERE key = ANY($1::text[])`,
    [PHASE_5_1_KEYS]
  );
  const byKey = new Map(q.rows.map((r) => [r.key, r]));
  const findings = [];
  for (const k of PHASE_5_1_KEYS) {
    const row = byKey.get(k);
    if (!row) {
      findings.push({ key: k, ok: false, reason: "row missing in platform_themes" });
    } else if (!row.is_published) {
      findings.push({ key: k, ok: false, reason: "row exists but is_published=FALSE" });
    } else {
      findings.push({
        key: k,
        ok: true,
        layout_key: row.layout_key,
        token_count: parseInt(row.token_count, 10),
      });
    }
  }
  return findings;
}

async function runWriteBaseline() {
  console.log("Capturing baseline of all published tenant snapshots…");
  const tenants = await fetchPublishedTenants();
  const baseline = {
    timestamp: new Date().toISOString(),
    tenantCount: tenants.length,
    tenants: {},
  };
  for (const t of tenants) {
    process.stdout.write(`  ${pad(t.slug, 28)} ${t.theme_key}…`);
    try {
      const snap = await resolveTenantAppearanceSnapshot(t.id);
      baseline.tenants[t.id] = {
        slug: t.slug,
        themeKey: snap.themeKey,
        layoutKey: snap.layoutKey,
        resolvedCssVars: snap.resolvedCssVars,
        resolvedContractCssVars: snap.resolvedContractCssVars,
      };
      console.log(" ok");
    } catch (err) {
      console.log(" FAIL: " + err.message);
      baseline.tenants[t.id] = { slug: t.slug, error: err.message };
    }
  }
  const outPath = path.isAbsolute(WRITE_BASELINE)
    ? WRITE_BASELINE
    : path.join(__dirname, WRITE_BASELINE);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2));
  console.log(`\nBaseline written to ${outPath}`);
  console.log(`Captured ${tenants.length} tenant(s).`);
}

async function runVerify() {
  const HR = "═".repeat(76);
  const SR = "─".repeat(76);

  console.log(HR);
  console.log("THEMES-V2 Phase 5.1 — Post-Sync Verification (03)");
  console.log(HR);
  console.log(`Mode:        ${BASELINE_FILE ? `compare vs baseline ${BASELINE_FILE}` : "compare vs live stored snapshots"}`);
  console.log(`Protected:   ${[...PROTECTED_IDS].join(", ")}`);
  console.log("");

  // ── Phase 5.1 row presence ─────────────────────────────────────────
  console.log(SR);
  console.log("Phase 5.1 rows in platform_themes");
  console.log(SR);
  const rowFindings = await checkPhase5_1Rows();
  let rowFail = false;
  for (const f of rowFindings) {
    if (f.ok) {
      console.log(`  ${pad(f.key, 22)} ✓ present  layout=${f.layout_key}  tokens=${f.token_count}`);
    } else {
      console.log(`  ${pad(f.key, 22)} ✗ ${f.reason}`);
      rowFail = true;
    }
  }
  console.log("");

  // ── Load baseline (if specified) ───────────────────────────────────
  let baseline = null;
  if (BASELINE_FILE) {
    const baselinePath = path.isAbsolute(BASELINE_FILE)
      ? BASELINE_FILE
      : path.join(__dirname, BASELINE_FILE);
    try {
      baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    } catch (err) {
      console.error(`Failed to read baseline ${baselinePath}: ${err.message}`);
      await safeShutdown(1);
    }
  }

  // ── Tenant sweep ───────────────────────────────────────────────────
  console.log(SR);
  console.log("Tenant resolved-vars verification (fresh compute vs " +
    (baseline ? "baseline" : "stored snapshot") + ")");
  console.log(SR);

  const tenants = await fetchPublishedTenants();
  const findings = [];
  let protectedFail = false;
  let totalDiffs = 0;
  let staleSnapshots = 0;

  for (const t of tenants) {
    const isProtected = PROTECTED_IDS.has(t.id);
    let comparedTo;
    if (baseline) {
      const base = baseline.tenants && baseline.tenants[t.id];
      if (!base || !base.resolvedCssVars) {
        findings.push({
          id: t.id, slug: t.slug, themeKey: t.theme_key,
          isProtected, status: "NO_BASELINE_ENTRY",
        });
        if (isProtected) protectedFail = true;
        continue;
      }
      comparedTo = base.resolvedCssVars;
    } else {
      const stored = toObj(t.appearance_snapshot_published_json);
      if (!stored.resolvedCssVars) {
        findings.push({
          id: t.id, slug: t.slug, themeKey: t.theme_key,
          isProtected, status: "NO_STORED_SNAPSHOT",
        });
        if (isProtected) protectedFail = true;
        continue;
      }
      comparedTo = stored.resolvedCssVars;
    }

    let fresh;
    try {
      fresh = await resolveTenantAppearanceSnapshot(t.id);
    } catch (err) {
      findings.push({
        id: t.id, slug: t.slug, themeKey: t.theme_key,
        isProtected, status: "RESOLVE_FAILED", error: err.message,
      });
      if (isProtected) protectedFail = true;
      continue;
    }

    const diffs = diffMaps(comparedTo, fresh.resolvedCssVars);
    if (diffs.length === 0) {
      findings.push({
        id: t.id, slug: t.slug, themeKey: t.theme_key,
        isProtected, status: "CLEAN", diffCount: 0,
      });
      continue;
    }

    // Heuristic: if stored marker differs from fresh, treat as STALE_SNAPSHOT
    // (refresh-snapshots.js territory, not a Phase 5.1 problem).
    const storedMarker = !baseline
      ? toObj(t.appearance_snapshot_published_json).debugSnapshotMarker
      : null;
    const isStale =
      !baseline &&
      storedMarker &&
      storedMarker !== fresh.debugSnapshotMarker;

    if (isStale) staleSnapshots++;
    totalDiffs++;

    findings.push({
      id: t.id, slug: t.slug, themeKey: t.theme_key,
      isProtected,
      status: isStale ? "STALE_SNAPSHOT" : "DIFF",
      diffCount: diffs.length,
      storedMarker: storedMarker || null,
      freshMarker: fresh.debugSnapshotMarker,
      diffs,
    });

    if (isProtected) {
      protectedFail = true;
    }
  }

  // ── Print findings ─────────────────────────────────────────────────
  console.log(`  ${pad("status", 20)} ${pad("id", 4)} ${pad("slug", 24)} ${pad("theme_key", 22)} diffs`);
  console.log(`  ${"-".repeat(20)} ${"-".repeat(4)} ${"-".repeat(24)} ${"-".repeat(22)} -----`);
  for (const f of findings) {
    const tag = f.isProtected ? " ⚠" : "";
    const dc = f.diffCount === undefined ? "-" : String(f.diffCount);
    console.log(`  ${pad(f.status + tag, 20)} ${pad(f.id, 4)} ${pad(f.slug, 24)} ${pad(f.themeKey || "", 22)} ${dc}`);
  }
  console.log("");

  // ── Verbose / protected diff dumps ─────────────────────────────────
  const protectedFindings = findings.filter((f) => f.isProtected);
  for (const f of protectedFindings) {
    if (f.status === "CLEAN") continue;
    console.log(SR);
    console.log(`Protected tenant detail — ${f.slug} (id=${f.id})  status=${f.status}`);
    console.log(SR);
    if (f.error) console.log(`  error: ${f.error}`);
    if (f.storedMarker || f.freshMarker) {
      console.log(`  marker: ${f.storedMarker || "(none)"} → ${f.freshMarker || "(none)"}`);
    }
    if (f.diffs && f.diffs.length > 0) {
      const shown = f.diffs.slice(0, 20);
      for (const d of shown) {
        const tags = [];
        if (d.blocked) tags.push("BLOCKED");
        if (d.addition) tags.push("+ADDITION");
        const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
        console.log(`    ${pad(d.key, 32)} : ${String(d.current).padEnd(28).slice(0, 28)} → ${d.simulated}${tagStr}`);
      }
      if (f.diffs.length > 20) console.log(`    … (+${f.diffs.length - 20} more in log)`);
    }
    console.log("");
  }

  if (VERBOSE) {
    const nonProtectedDiffs = findings.filter((f) => !f.isProtected && f.diffs && f.diffs.length > 0);
    for (const f of nonProtectedDiffs) {
      console.log(`  ${f.slug} (id=${f.id})  status=${f.status}  diffCount=${f.diffCount}`);
      if (f.diffs.length > 0) {
        for (const d of f.diffs.slice(0, 5)) {
          console.log(`      ${pad(d.key, 28)} : ${String(d.current).slice(0, 30)} → ${String(d.simulated).slice(0, 30)}`);
        }
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log(HR);
  console.log("Summary");
  console.log(HR);
  const counts = {};
  for (const f of findings) counts[f.status] = (counts[f.status] || 0) + 1;
  for (const [s, n] of Object.entries(counts)) console.log(`  ${pad(s, 24)} ${n}`);
  console.log(`  ${pad("(of which protected)", 24)} ${protectedFindings.length}`);
  console.log("");
  console.log(`  Phase 5.1 row check:    ${rowFail ? "FAIL" : "ok"}`);
  console.log(`  Protected tenants:      ${protectedFail ? "FAIL" : "ok"}`);
  console.log(`  Total tenant diffs:     ${totalDiffs} (${staleSnapshots} attributable to stale snapshot markers)`);
  console.log("");

  // Log
  const log = {
    timestamp: new Date().toISOString(),
    mode: baseline ? "baseline" : "stored",
    baselineFile: BASELINE_FILE,
    protectedIds: [...PROTECTED_IDS],
    phase5_1RowCheck: rowFindings,
    findings,
    summary: { counts, protectedFail, rowFail, totalDiffs, staleSnapshots },
  };
  const auditDir = path.join(__dirname, ".audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const safeTs = log.timestamp.replace(/[:.]/g, "-");
  const logPath = path.join(auditDir, `03_verify_${safeTs}.json`);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log(`Log: ${logPath}`);
  console.log("");

  if (rowFail || protectedFail) {
    console.log("VERIFICATION FAILED.");
    await safeShutdown(1);
  } else {
    console.log("Verification passed.");
    await safeShutdown(0);
  }
}

async function safeShutdown(code) {
  try { await db.pool.end(); } catch { /* ignore */ }
  process.exit(code);
}

async function main() {
  if (WRITE_BASELINE) {
    await runWriteBaseline();
    await safeShutdown(0);
  } else {
    await runVerify();
  }
}

main().catch(async (err) => {
  console.error("Fatal:", err && err.stack ? err.stack : err);
  await safeShutdown(1);
});
