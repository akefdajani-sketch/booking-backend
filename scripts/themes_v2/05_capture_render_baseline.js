#!/usr/bin/env node
/**
 * scripts/themes_v2/05_capture_render_baseline.js
 * ─────────────────────────────────────────────────────────────────────────
 * THEMES-V2 Phase 5.3 — pre-refactor baseline capture.
 *
 * Captures rendered-HTML + API-payload snapshots of every published
 * tenant's public booking page BEFORE Phase 5.3's SectionRenderer
 * refactor lands. The intent: anything that changes byte-for-byte
 * AFTER the refactor is a regression candidate.
 *
 * Per tenant, captures:
 *   <slug>.html              full rendered HTML from GET <base-url>/book/<slug>
 *   <slug>.html.sha256       content hash for fast equality check
 *   <slug>.api.json          backend JSON from GET <api-base-url>/api/public/tenant-theme/<slug>
 *   <slug>.api.json.sha256   content hash
 *   <slug>.meta.json         status codes + response headers from BOTH requests
 *
 * Plus a single INDEX.json summary that's the only file meant for git.
 *
 * Default targets:
 *   HTML  http://localhost:3000/book/<slug>    (Next.js frontend dev)
 *   API   http://localhost:3001/api/public/tenant-theme/<slug>  (this backend)
 *
 * Usage:
 *   node scripts/themes_v2/05_capture_render_baseline.js
 *   node scripts/themes_v2/05_capture_render_baseline.js --slug-filter=birdie-golf,alrazi
 *   node scripts/themes_v2/05_capture_render_baseline.js --base-url=https://booking-frontend-preview.vercel.app
 *   node scripts/themes_v2/05_capture_render_baseline.js --timeout-ms=10000
 *
 * Phase 5.3 prod-capture invocation (see
 * audit/2026-05-17/phase-5-3-baseline-capture-extensions.md):
 *   node scripts/themes_v2/05_capture_render_baseline.js \
 *     --prod --custom-domains \
 *     --output-dir=snapshots/phase-5-3-baseline
 *
 * --prod implies --base-url=https://flexrz.com,
 *                --api-base-url=https://booking-backend-6jbc.onrender.com,
 *                --rate-limit-ms=1000 (each independently overridable).
 * --custom-domains uses tenant_domains.domain when a tenant has a primary
 * custom domain; otherwise falls back to <base-url>/book/<slug>.
 *
 * Exit codes:
 *   0  capture completed (findings are surfaced but NOT fatal — a timeout
 *      on tenant N is a finding, not a failure of the script)
 *   1  fatal: DB unreachable, output dir not writable, etc.
 */

"use strict";

try { require("dotenv").config(); } catch { /* dotenv optional in prod */ }

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const db = require("../../db");

// ── CLI ──────────────────────────────────────────────────────────────────
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

const PROD_MODE = hasArg("--prod");
const HTML_BASE = getArg(
  "--base-url",
  PROD_MODE ? "https://flexrz.com" : "http://localhost:3000"
);
const API_BASE = getArg(
  "--api-base-url",
  PROD_MODE ? "https://booking-backend-6jbc.onrender.com" : "http://localhost:3001"
);
const TIMEOUT_MS = parseInt(getArg("--timeout-ms", "5000"), 10);
const OUTPUT_DIR_REL = getArg("--output-dir", ".audit/baseline");
const SLUG_FILTER_RAW = getArg("--slug-filter", null);
const SLUG_FILTER = SLUG_FILTER_RAW
  ? new Set(SLUG_FILTER_RAW.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const CUSTOM_DOMAINS = hasArg("--custom-domains");
// Rate limit defaults to 1000ms under --prod (politeness against prod hosts),
// 0 otherwise (preserves existing localhost dev speed).
const RATE_LIMIT_MS = parseInt(
  getArg("--rate-limit-ms", PROD_MODE ? "1000" : "0"),
  10
);
const USER_AGENT = getArg(
  "--user-agent",
  "Flexrz-Internal-Phase-5-3-Audit/1.0"
);
// Per-tenant URL override. Maps each slug to the exact URL we want captured,
// bypassing tenant_domains resolution. Used for canonical-URL fixes like
// apex→www where the inventory has the apex but Vercel routes everyone to www.
// Format: --custom-domain-override=slug1=url1,slug2=url2
const URL_OVERRIDE_RAW = getArg("--custom-domain-override", "");
const URL_OVERRIDES = new Map();
if (URL_OVERRIDE_RAW) {
  for (const pair of URL_OVERRIDE_RAW.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      console.error(`Fatal: malformed --custom-domain-override entry: "${pair}"`);
      console.error(`       expected: slug=https://full-url/`);
      process.exit(1);
    }
    URL_OVERRIDES.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

const OUTPUT_DIR = path.isAbsolute(OUTPUT_DIR_REL)
  ? OUTPUT_DIR_REL
  : path.join(process.cwd(), OUTPUT_DIR_REL);

// ── Helpers ──────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const start = Date.now();
  try {
    // redirect:"manual" so a 302 is surfaced as a finding rather than silently followed
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: buf,
      elapsed_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.name === "AbortError" ? "TIMEOUT" : (err.code || err.message),
      elapsed_ms: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// Per-tenant URL resolver. When --custom-domains is on and the tenant has
// a primary custom domain, HTML target is the custom-domain root (the
// middleware routes the booking flow at the domain root, not /book/<slug>).
// API target ALWAYS uses API_BASE — the backend is single-host regardless
// of custom domains.
function resolveUrls(t) {
  // Override wins over DB-derived custom domain. urlSource discriminates
  // between override / DB / slug-route so the INDEX captures provenance.
  const override = URL_OVERRIDES.get(t.slug);
  const useCustom =
    !override && CUSTOM_DOMAINS && t.custom_domain && t.custom_domain_is_primary;
  const htmlUrl = override
    ? override
    : useCustom
      ? `https://${t.custom_domain}/`
      : `${HTML_BASE}/book/${encodeURIComponent(t.slug)}`;
  const apiUrl = `${API_BASE}/api/public/tenant-theme/${encodeURIComponent(t.slug)}`;
  return {
    htmlUrl,
    apiUrl,
    usedCustomDomain: !!(override || useCustom),
    urlSource: override ? "override" : useCustom ? "db" : "slug-route",
  };
}

// Schema-drift guard: --custom-domains needs tenant_domains.is_primary.
// Fail loud rather than silently capturing the wrong URLs.
async function assertSchemaForCustomDomains() {
  const r = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tenant_domains'
        AND column_name = 'is_primary'
        AND table_schema = current_schema()`
  );
  if (r.rows.length === 0) {
    console.error("Fatal: --custom-domains was passed, but expected column");
    console.error("       tenant_domains.is_primary not found on this schema.");
    console.error("       Schema drift between this code and the target DB.");
    console.error("       Coordinate with audit/2026-05-14/schema_drift/REPORT.md");
    console.error("       before re-running with --custom-domains.");
    await safeShutdown(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(76));
  console.log("THEMES-V2 Phase 5.3 — Baseline Capture");
  console.log("═".repeat(76));
  if (PROD_MODE) console.log("Mode:           --prod (production capture)");
  console.log(`HTML base:      ${HTML_BASE}`);
  console.log(`API base:       ${API_BASE}`);
  console.log(`Timeout:        ${TIMEOUT_MS}ms`);
  console.log(`Output dir:     ${OUTPUT_DIR}`);
  if (CUSTOM_DOMAINS) console.log("Custom domains: enabled");
  if (RATE_LIMIT_MS > 0) console.log(`Rate limit:     ${RATE_LIMIT_MS}ms between tenants`);
  console.log(`User-Agent:     ${USER_AGENT}`);
  if (SLUG_FILTER) console.log(`Slug filter:    ${[...SLUG_FILTER].join(", ")}`);
  if (URL_OVERRIDES.size) {
    console.log("URL overrides:");
    for (const [slug, url] of URL_OVERRIDES) console.log(`  ${slug} → ${url}`);
  }
  console.log("");

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (CUSTOM_DOMAINS) await assertSchemaForCustomDomains();

  // Published tenants only — drafts aren't routable on /book/<slug>
  const q = await db.query(
    CUSTOM_DOMAINS
      ? `SELECT t.id, t.slug, t.theme_key, t.publish_status,
                td.domain     AS custom_domain,
                td.is_primary AS custom_domain_is_primary
           FROM tenants t
           LEFT JOIN tenant_domains td
             ON td.tenant_id = t.id AND td.is_primary = TRUE
          WHERE t.publish_status = 'published'
          ORDER BY t.id`
      : `SELECT id, slug, theme_key, publish_status
           FROM tenants
          WHERE publish_status = 'published'
          ORDER BY id`
  );
  let tenants = q.rows;
  if (SLUG_FILTER) tenants = tenants.filter((t) => SLUG_FILTER.has(t.slug));
  console.log(`Tenants to capture: ${tenants.length}`);
  if (tenants.length === 0) {
    console.log("No tenants match the filter — nothing to do.");
    await safeShutdown(0);
    return;
  }
  console.log("");
  console.log("─".repeat(76));
  console.log(`  ${pad("slug", 28)} ${pad("html", 22)} ${"api"}`);
  console.log("─".repeat(76));

  const indexEntries = [];
  const findings = [];

  for (const t of tenants) {
    const { htmlUrl, apiUrl, usedCustomDomain, urlSource } = resolveUrls(t);

    const htmlR = await fetchWithTimeout(htmlUrl, TIMEOUT_MS);
    const apiR = await fetchWithTimeout(apiUrl, TIMEOUT_MS);

    const entry = {
      slug: t.slug,
      tenantId: t.id,
      themeKey: t.theme_key,
      usedCustomDomain,
      customDomain: usedCustomDomain ? t.custom_domain : null,
      urlSource,
    };

    // ── HTML artifact ──
    if (htmlR.ok) {
      const h = sha256(htmlR.body);
      fs.writeFileSync(path.join(OUTPUT_DIR, `${t.slug}.html`), htmlR.body);
      fs.writeFileSync(path.join(OUTPUT_DIR, `${t.slug}.html.sha256`), h + "\n");
      entry.html = {
        status: htmlR.status,
        bytes: htmlR.body.length,
        sha256: h,
        elapsed_ms: htmlR.elapsed_ms,
      };
      if (htmlR.status >= 400) {
        findings.push(`${t.slug}: HTML ${htmlR.status}`);
      } else if (htmlR.status >= 300 && htmlR.status < 400) {
        const loc = htmlR.headers && htmlR.headers.location;
        findings.push(`${t.slug}: HTML ${htmlR.status} redirect → ${loc || "(no Location)"}`);
      }
    } else {
      entry.html = { error: htmlR.error, elapsed_ms: htmlR.elapsed_ms };
      findings.push(`${t.slug}: HTML ${htmlR.error}`);
    }

    // ── API artifact ──
    if (apiR.ok) {
      const h = sha256(apiR.body);
      fs.writeFileSync(path.join(OUTPUT_DIR, `${t.slug}.api.json`), apiR.body);
      fs.writeFileSync(path.join(OUTPUT_DIR, `${t.slug}.api.json.sha256`), h + "\n");
      entry.api = {
        status: apiR.status,
        bytes: apiR.body.length,
        sha256: h,
        elapsed_ms: apiR.elapsed_ms,
      };
      if (apiR.status >= 400) findings.push(`${t.slug}: API ${apiR.status}`);
    } else {
      entry.api = { error: apiR.error, elapsed_ms: apiR.elapsed_ms };
      findings.push(`${t.slug}: API ${apiR.error}`);
    }

    // ── Meta (headers + status) ──
    const meta = {
      slug: t.slug,
      tenantId: t.id,
      themeKey: t.theme_key,
      capturedAt: new Date().toISOString(),
      html: {
        url: htmlUrl,
        status: htmlR.ok ? htmlR.status : null,
        headers: htmlR.ok ? htmlR.headers : null,
        error: htmlR.ok ? null : htmlR.error,
        elapsed_ms: htmlR.elapsed_ms,
      },
      api: {
        url: apiUrl,
        status: apiR.ok ? apiR.status : null,
        headers: apiR.ok ? apiR.headers : null,
        error: apiR.ok ? null : apiR.error,
        elapsed_ms: apiR.elapsed_ms,
      },
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, `${t.slug}.meta.json`), JSON.stringify(meta, null, 2));

    indexEntries.push(entry);

    const htmlMsg = htmlR.ok
      ? `${htmlR.status} ${htmlR.body.length}B ${htmlR.elapsed_ms}ms`
      : `${htmlR.error} ${htmlR.elapsed_ms}ms`;
    const apiMsg = apiR.ok
      ? `${apiR.status} ${apiR.body.length}B ${apiR.elapsed_ms}ms`
      : `${apiR.error} ${apiR.elapsed_ms}ms`;
    console.log(`  ${pad(t.slug, 28)} ${pad(htmlMsg, 22)} ${apiMsg}`);

    await sleep(RATE_LIMIT_MS);
  }

  // ── INDEX.json (only file meant for git) ──
  const index = {
    timestamp: new Date().toISOString(),
    prodMode: PROD_MODE,
    htmlBase: HTML_BASE,
    apiBase: API_BASE,
    timeoutMs: TIMEOUT_MS,
    customDomainsEnabled: CUSTOM_DOMAINS,
    customDomainOverrides: URL_OVERRIDES.size ? Object.fromEntries(URL_OVERRIDES) : null,
    rateLimitMs: RATE_LIMIT_MS,
    userAgent: USER_AGENT,
    slugFilter: SLUG_FILTER ? [...SLUG_FILTER] : null,
    tenantCount: indexEntries.length,
    captured: indexEntries,
    findings,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, "INDEX.json"), JSON.stringify(index, null, 2));

  console.log("");
  console.log("═".repeat(76));
  console.log("Summary");
  console.log("═".repeat(76));
  const htmlOk = indexEntries.filter((e) => e.html && e.html.status >= 200 && e.html.status < 300).length;
  const apiOk = indexEntries.filter((e) => e.api && e.api.status >= 200 && e.api.status < 300).length;
  console.log(`  HTML 2xx: ${htmlOk}/${indexEntries.length}`);
  console.log(`  API  2xx: ${apiOk}/${indexEntries.length}`);
  console.log(`  Findings: ${findings.length}`);
  for (const f of findings) console.log(`    ⚠ ${f}`);
  console.log("");
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log(`Index:      ${path.join(OUTPUT_DIR, "INDEX.json")}  (commit this only)`);

  await safeShutdown(0);
}

async function safeShutdown(code) {
  try { await db.pool.end(); } catch { /* ignore */ }
  process.exit(code);
}

main().catch(async (err) => {
  console.error("Fatal:", err && err.stack ? err.stack : err);
  await safeShutdown(1);
});
