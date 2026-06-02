#!/usr/bin/env node
/**
 * scripts/themes_v2/07_diff_against_baseline.js
 * THEMES-V2 Phase 5.3 — diff a post-refactor capture against the
 * pre-refactor baseline produced by 05_capture_render_baseline.js.
 *
 * Hash short-circuit: matching <slug>.html.sha256 → verdict PASS without
 * reading HTML. Mismatch → normalize whitelist (build IDs, CSRF, __NEXT_DATA__
 * buildId/timestamps, CSS-module class hashes, Sentry traceId, whitespace),
 * then line-by-line diff into hunks.
 *
 * Verdicts: PASS | DIFF | ERROR | NEW | DROPPED.  Exit: 0 all PASS, 1 any
 * DIFF/NEW/DROPPED, 2 read errors.  Companion .json written beside the .md.
 *
 * Usage:
 *   node scripts/themes_v2/07_diff_against_baseline.js \
 *     --baseline-dir=snapshots/phase-5-3-baseline \
 *     --current-dir=snapshots/phase-5-3-current \
 *     --output=audit/2026-05-17/phase-5-3-diff-report.md
 *
 * See audit/2026-05-17/phase-5-3-baseline-capture-extensions.md for the
 * companion capture script's flag set.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ── CLI ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}
function hasArg(name) {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}

const BASELINE_DIR = getArg("--baseline-dir", null);
const CURRENT_DIR = getArg("--current-dir", null);
const OUTPUT_MD = getArg("--output", "phase-5-3-diff-report.md");
const OUTPUT_JSON = OUTPUT_MD.replace(/\.md$/i, "") + ".json";
const MAX_HUNKS = parseInt(getArg("--max-hunks-per-tenant", "3"), 10);
const MAX_LINES_PER_HUNK = parseInt(getArg("--max-lines-per-hunk", "20"), 10);
const SLUG_FILTER_RAW = getArg("--slug-filter", null);
const SLUG_FILTER = SLUG_FILTER_RAW
  ? new Set(SLUG_FILTER_RAW.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const NO_NORMALIZE = hasArg("--no-normalize");

if (!BASELINE_DIR || !CURRENT_DIR) {
  console.error("Fatal: --baseline-dir and --current-dir are required.");
  console.error("       See header for usage.");
  process.exit(2);
}

// ── Normalizer ────────────────────────────────────────────────────────────
// __NEXT_DATA__ runs first (parse-then-re-serialize), then the regex rules
// in declared order, then whitespace cleanup. Order matters: regex rules
// after the JSON pass so they don't accidentally rewrite inside JSON
// string values before parsing.

function normalizeNextData(text) {
  return text.replace(
    /(<script\s+id="__NEXT_DATA__"[^>]*>)([\s\S]*?)(<\/script>)/,
    (_m, open, body, close) => {
      let obj;
      try { obj = JSON.parse(body); } catch { return _m; }
      const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
      const walk = (v) => {
        if (typeof v === "string" && isoRe.test(v)) return "[TIMESTAMP]";
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
          const out = {};
          for (const k of Object.keys(v)) out[k] = walk(v[k]);
          return out;
        }
        return v;
      };
      if (obj && typeof obj === "object") {
        if ("buildId" in obj) obj.buildId = "[BUILD-ID]";
        obj = walk(obj);
      }
      return open + JSON.stringify(obj) + close;
    }
  );
}

const REGEX_RULES = [
  { name: "next_static_build_id",
    pattern: /\/_next\/static\/[^\/"'\s]+\//g,
    replacement: "/_next/static/[BUILD-ID]/" },
  { name: "data_build_id_attr",
    pattern: /(data-build-id=")[^"]*(")/g,
    replacement: "$1[BUILD-ID]$2" },
  { name: "csrf_token",
    pattern: /(<input[^>]*\bname="_csrf"[^>]*\bvalue=")[^"]*(")/g,
    replacement: "$1[CSRF]$2" },
  { name: "og_url_query_timestamps",
    pattern: /(<meta\s+property="og:url"[^>]*\bcontent="[^"?#]*\?[^"]*?)\b(?:t|ts|_)=[0-9]+(&|"|$)/g,
    replacement: "$1[TS]$2" },
  { name: "cache_buster_query",
    pattern: /(\?v=)[0-9a-fA-F]+/g,
    replacement: "$1[HASH]" },
  { name: "rendered_at_comment",
    pattern: /<!--\s*rendered at[^>]*-->/gi,
    replacement: "" },
  { name: "sentry_trace_id",
    pattern: /(traceId\s*:\s*"\s*)[0-9a-fA-F]{32}(\s*")/g,
    replacement: "$1[TRACE-ID]$2" },
  { name: "css_module_hash_suffix",
    pattern: /(__)[A-Za-z0-9_-]{5,8}(?=[\s"'>])/g,
    replacement: "$1[HASH]" },
  // App Router emits per-request Sentry IDs in <head> meta tags; the legacy
  // sentry_trace_id rule above only matches Pages-Router-shaped JSON.
  // sentry-release stays unmasked — it's the deployed commit SHA and a
  // deploy-identity signal we want surfaced if it drifts between captures.
  { name: "sentry_trace_meta",
    pattern: /(<meta\s+name="sentry-trace"\s+content=")[^"]*(")/g,
    replacement: "$1[SENTRY-TRACE]$2" },
  { name: "sentry_baggage_trace_id",
    pattern: /(sentry-trace_id=)[0-9a-f]{32}/g,
    replacement: "$1[TRACE-ID]" },
  { name: "sentry_baggage_sample_rand",
    pattern: /(sentry-sample_rand=)[0-9.]+/g,
    replacement: "$1[RAND]" },
  // Stateful debug blob; appears raw in <head> AND escaped inside
  // __next_f.push flight payloads. One anchor handles both because the
  // interior never contains '<' before the closing '};'.
  { name: "bf_ssr_debug_blob",
    pattern: /(window\.__BF_SSR_DEBUG__\s*=\s*)\{[^<]*?\};/g,
    replacement: "$1[BF-SSR-DEBUG];" },
  // snapshotUsed / snapshotVersion are backend cache-warmth signals that
  // also leak into the API tenant-theme payload embedded in the React
  // Flight stream. The (\\*") + \1 backref matches raw, single-escaped,
  // and triple-escaped quote levels symmetrically.
  { name: "snapshot_used_field",
    pattern: /(\\*")snapshotUsed\1\s*:\s*(true|false)/g,
    replacement: "$1snapshotUsed$1:[CACHE]" },
  { name: "snapshot_version_field",
    pattern: /(\\*")snapshotVersion\1\s*:\s*\d+/g,
    replacement: "$1snapshotVersion$1:[CACHE]" },
  // The appearance subtree (landing/assets/resolvedCssVars/resolvedContractCssVars)
  // is also embedded as escaped JSON inside React Flight pushes. Same backend
  // key-order non-determinism applies. Standalone copy is handled via
  // canonicalizeJson in compareTenant; this masks the duplicate here. Bounded
  // by "landing":{ on the left and the snapshotUsed:[CACHE] sentinel produced
  // by snapshot_used_field on the right. Region verified pure data (no Flight
  // component-tree markers) so masking loses zero signal.
  { name: "embedded_appearance_data_island",
    pattern: /(\\*")landing\1:\{[\s\S]*?\1snapshotUsed\1:\[CACHE\]/g,
    replacement: "$1landing$1:[APPEARANCE-DATA-ISLAND],$1snapshotUsed$1:[CACHE]" },
];

function collapseWhitespace(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .reduce((acc, line) => {
      if (line === "" && acc.length && acc[acc.length - 1] === "") return acc;
      acc.push(line);
      return acc;
    }, [])
    .join("\n");
}

function normalize(text) {
  if (NO_NORMALIZE) return text;
  let t = normalizeNextData(text);
  for (const r of REGEX_RULES) t = t.replace(r.pattern, r.replacement);
  return collapseWhitespace(t);
}

// ── IO ────────────────────────────────────────────────────────────────────
function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function readUtf8OrNull(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}
function readShaOrNull(p) {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; }
}
// Defangs non-stable JSON key order from the backend tenant-theme snapshot
// serializer (cold/warm cache paths emit same keys/values in different order).
// See memory: themes-v2-backend-stable-key-order.
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}
function canonicalizeJson(text) {
  try { return JSON.stringify(sortDeep(JSON.parse(text))); }
  catch { return null; }
}
function buildTenantUnion(baseline, current) {
  const b = new Set((baseline.captured || []).map((c) => c.slug));
  const c = new Set((current.captured || []).map((c) => c.slug));
  const all = new Set([...b, ...c]);
  if (SLUG_FILTER) for (const s of [...all]) if (!SLUG_FILTER.has(s)) all.delete(s);
  return [...all].sort();
}

function metaWarnings(baseline, current) {
  const warn = [];
  for (const k of ["htmlBase", "apiBase", "customDomainsEnabled", "customDomainOverrides", "userAgent", "timeoutMs", "slugFilter"]) {
    const a = JSON.stringify(baseline[k] ?? null);
    const c = JSON.stringify(current[k] ?? null);
    if (a !== c) warn.push(`baseline.${k}=${a} != current.${k}=${c}`);
  }
  return warn;
}

// ── Line diff (LCS-based) ─────────────────────────────────────────────────
function lcsTable(a, b) {
  const m = a.length, n = b.length;
  const t = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t;
}

function diffLines(aText, bText) {
  const a = aText.split("\n"), b = bText.split("\n");
  // Memory safety: LCS table is O(m*n). Bail at 25M cells (~100MB).
  if (a.length * b.length > 25_000_000) {
    return [{ aStart: 1, bStart: 1, lines: ["? diff too large to compute hunks; inspect raw files manually"] }];
  }
  const t = lcsTable(a, b);
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ op: "=", line: a[i], ai: i, bi: j }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) { ops.push({ op: "-", line: a[i], ai: i, bi: j }); i++; }
    else { ops.push({ op: "+", line: b[j], ai: i, bi: j }); j++; }
  }
  while (i < a.length) { ops.push({ op: "-", line: a[i], ai: i, bi: j }); i++; }
  while (j < b.length) { ops.push({ op: "+", line: b[j], ai: i, bi: j }); j++; }
  const hunks = []; let cur = null;
  for (const o of ops) {
    if (o.op === "=") { if (cur) { hunks.push(cur); cur = null; } continue; }
    if (!cur) cur = { aStart: o.ai + 1, bStart: o.bi + 1, lines: [] };
    cur.lines.push((o.op === "-" ? "- " : "+ ") + o.line);
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// ── Per-tenant compare ────────────────────────────────────────────────────
function compareTenant(slug, baseline, current) {
  const bEntry = (baseline.captured || []).find((c) => c.slug === slug);
  const cEntry = (current.captured || []).find((c) => c.slug === slug);
  const out = {
    slug,
    tenantId: (bEntry || cEntry || {}).tenantId || null,
    verdict: "PASS",
    html: { baselineHash: null, currentHash: null, match: false, hunks: [] },
    api:  { baselineHash: null, currentHash: null, match: false },
    findings: [],
  };

  if (bEntry && !cEntry) { out.verdict = "DROPPED"; return out; }
  if (!bEntry && cEntry) { out.verdict = "NEW"; return out; }

  const bHtmlSha = readShaOrNull(path.join(BASELINE_DIR, `${slug}.html.sha256`));
  const cHtmlSha = readShaOrNull(path.join(CURRENT_DIR,  `${slug}.html.sha256`));
  const bApiSha  = readShaOrNull(path.join(BASELINE_DIR, `${slug}.api.json.sha256`));
  const cApiSha  = readShaOrNull(path.join(CURRENT_DIR,  `${slug}.api.json.sha256`));

  if (!bHtmlSha || !cHtmlSha) {
    out.verdict = "ERROR";
    out.findings.push("missing_html_capture");
    return out;
  }

  out.html.baselineHash = bHtmlSha;
  out.html.currentHash  = cHtmlSha;
  out.api.baselineHash  = bApiSha;
  out.api.currentHash   = cApiSha;
  out.api.match = !!(bApiSha && cApiSha && bApiSha === cApiSha);

  // Raw hash fast-path failed. Fall through to canonical-form compare so
  // backend key-order drift (cold vs warm cache path) doesn't surface as
  // a false api_drift. Real value drift still fails the canonical compare.
  if (!out.api.match && bApiSha && cApiSha) {
    const bApiJson = readUtf8OrNull(path.join(BASELINE_DIR, `${slug}.api.json`));
    const cApiJson = readUtf8OrNull(path.join(CURRENT_DIR,  `${slug}.api.json`));
    if (bApiJson != null && cApiJson != null) {
      const bCanon = canonicalizeJson(bApiJson);
      const cCanon = canonicalizeJson(cApiJson);
      if (bCanon != null && cCanon != null && bCanon === cCanon) {
        out.api.match = true;
      }
    }
  }

  if (bHtmlSha === cHtmlSha) {
    out.html.match = true;
    out.verdict = "PASS";
  } else {
    const bHtml = readUtf8OrNull(path.join(BASELINE_DIR, `${slug}.html`));
    const cHtml = readUtf8OrNull(path.join(CURRENT_DIR,  `${slug}.html`));
    if (bHtml == null || cHtml == null) {
      out.verdict = "ERROR";
      out.findings.push("html_read_failed");
      return out;
    }
    const bNorm = normalize(bHtml);
    const cNorm = normalize(cHtml);
    if (bNorm === cNorm) {
      out.html.match = true;
      out.verdict = "PASS";
    } else {
      out.html.match = false;
      out.verdict = "DIFF";
      out.html.hunks = diffLines(bNorm, cNorm);
    }
  }

  if (!out.api.match && out.api.baselineHash && out.api.currentHash) {
    out.findings.push("api_drift");
  }
  return out;
}

// ── Report writers ────────────────────────────────────────────────────────
function writeJsonReport(payload) {
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(payload, null, 2));
}

function renderMarkdown(payload) {
  const { timestamp, baselineDir, currentDir, baselineMeta, currentMeta, metaWarnings: warns, summary, tenants } = payload;
  const L = [];
  L.push(`# Phase 5.3 Diff Report`);
  L.push("");
  L.push(`Generated: ${timestamp}`);
  L.push(`Baseline: \`${baselineDir}\`  (n=${baselineMeta.tenantCount}, captured ${baselineMeta.timestamp})`);
  L.push(`Current:  \`${currentDir}\`   (n=${currentMeta.tenantCount}, captured ${currentMeta.timestamp})`);
  L.push("");
  L.push("## Meta warnings");
  if (warns.length === 0) L.push("- (none)");
  else for (const w of warns) L.push(`- ${w}`);
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push("| Verdict   | Count |");
  L.push("|-----------|------:|");
  L.push(`| PASS      | ${summary.pass} |`);
  L.push(`| DIFF      | ${summary.diff} |`);
  L.push(`| ERROR     | ${summary.error} |`);
  L.push(`| NEW       | ${summary.new} |`);
  L.push(`| DROPPED   | ${summary.dropped} |`);
  L.push(`| api_drift | ${summary.apiDrift} |`);
  L.push("");
  L.push("## Per-tenant verdicts");
  L.push("");
  L.push("| Slug | Verdict | HTML | API | Findings |");
  L.push("|------|---------|------|-----|----------|");
  for (const t of tenants) {
    const findings = t.findings.length ? t.findings.join(", ") : "";
    const apiCell = t.api.match ? "OK" : (t.api.baselineHash || t.api.currentHash ? "diff" : "—");
    L.push(`| ${t.slug} | ${t.verdict} | ${t.html.match ? "OK" : "diff"} | ${apiCell} | ${findings} |`);
  }
  L.push("");
  const diffs = tenants.filter((t) => t.verdict === "DIFF");
  if (diffs.length) {
    L.push("## Tenants with diffs");
    L.push("");
    for (const t of diffs) {
      L.push(`### ${t.slug} — DIFF`);
      const totalH = t.html.hunks.length;
      for (const h of t.html.hunks.slice(0, MAX_HUNKS)) {
        L.push("");
        L.push("```diff");
        L.push(`@@ -${h.aStart} +${h.bStart} @@`);
        for (const l of h.lines.slice(0, MAX_LINES_PER_HUNK)) L.push(l);
        if (h.lines.length > MAX_LINES_PER_HUNK)
          L.push(`... (${h.lines.length - MAX_LINES_PER_HUNK} more lines suppressed)`);
        L.push("```");
      }
      if (totalH > MAX_HUNKS) {
        L.push("");
        L.push(`*(${totalH - MAX_HUNKS} more hunks suppressed; see companion .json for full set.)*`);
      }
      L.push("");
    }
  }
  fs.writeFileSync(OUTPUT_MD, L.join("\n") + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────
function main() {
  const loadIdx = (dir) => {
    const idx = readJsonOrNull(path.join(dir, "INDEX.json"));
    if (!idx) { console.error(`Fatal: missing or unreadable ${path.join(dir, "INDEX.json")}`); process.exit(2); }
    return idx;
  };
  const baselineIdx = loadIdx(BASELINE_DIR);
  const currentIdx = loadIdx(CURRENT_DIR);
  const slugs = buildTenantUnion(baselineIdx, currentIdx);
  const warnings = metaWarnings(baselineIdx, currentIdx);

  console.log("═".repeat(76));
  console.log("THEMES-V2 Phase 5.3 — Diff Against Baseline");
  console.log("═".repeat(76));
  console.log(`Baseline:  ${BASELINE_DIR}`);
  console.log(`Current:   ${CURRENT_DIR}`);
  console.log(`Output MD: ${OUTPUT_MD}`);
  console.log(`Output JSON: ${OUTPUT_JSON}`);
  console.log(`Tenants:   ${slugs.length}`);
  if (NO_NORMALIZE) console.log(`Normalize: DISABLED (--no-normalize)`);
  if (warnings.length) {
    console.log("Meta warnings:");
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  console.log("");

  const tenants = [];
  for (const slug of slugs) {
    const t = compareTenant(slug, baselineIdx, currentIdx);
    tenants.push(t);
    const apiCell = t.api.match ? "api=ok" : (t.api.baselineHash || t.api.currentHash ? "api=diff" : "api=—");
    console.log(`  ${slug.padEnd(28)} ${t.verdict.padEnd(8)} html=${t.html.match ? "ok" : "diff"}  ${apiCell}  ${t.findings.join(",")}`);
  }

  const summary = {
    pass: tenants.filter((t) => t.verdict === "PASS").length,
    diff: tenants.filter((t) => t.verdict === "DIFF").length,
    error: tenants.filter((t) => t.verdict === "ERROR").length,
    new: tenants.filter((t) => t.verdict === "NEW").length,
    dropped: tenants.filter((t) => t.verdict === "DROPPED").length,
    apiDrift: tenants.filter((t) => t.findings.includes("api_drift")).length,
  };

  let exitCode = 0;
  if (summary.error > 0) exitCode = 2;
  if (summary.diff > 0 || summary.new > 0 || summary.dropped > 0) exitCode = Math.max(exitCode, 1);

  const payload = {
    timestamp: new Date().toISOString(),
    baselineDir: BASELINE_DIR,
    currentDir: CURRENT_DIR,
    baselineMeta: baselineIdx,
    currentMeta: currentIdx,
    metaWarnings: warnings,
    summary,
    tenants,
    exitCode,
  };

  fs.mkdirSync(path.dirname(OUTPUT_MD) || ".", { recursive: true });
  writeJsonReport(payload);
  renderMarkdown(payload);

  console.log("");
  console.log("Summary:");
  for (const k of ["pass", "diff", "error", "new", "dropped", "apiDrift"])
    console.log(`  ${k}: ${summary[k]}`);
  console.log("");
  console.log(`MD:   ${OUTPUT_MD}`);
  console.log(`JSON: ${OUTPUT_JSON}`);
  console.log(`Exit: ${exitCode}`);
  process.exit(exitCode);
}

main();
