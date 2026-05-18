# Phase 5.3 — Baseline Capture Extensions (Scoping)

> Extension spec for `scripts/themes_v2/05_capture_render_baseline.js`
> covering the Phase 5.3 SectionRenderer pre-refactor baseline capture.
> All changes are **additive**: callers that don't pass any of the new
> flags see byte-identical behavior to the pre-extension version,
> except for the User-Agent header (see "Default-preservation
> guarantee" below).

## Why script 05 (not a new 06)

Script 05's header already says it's a "Phase 5.3 pre-refactor baseline
capture." It was written for exactly this purpose, with the right
shape: per-tenant HTML + API capture, content hashes, INDEX.json,
findings surface. The only gaps for prod use are:

1. Default base URLs point at localhost (dev convenience).
2. No per-tenant URL resolution — every tenant fetched via
   `<base-url>/book/<slug>`. Tenants on custom domains can't be
   captured correctly that way (their middleware routes the booking
   flow at the domain root, not `/book/<slug>`).
3. No rate limiting — fast for localhost; impolite against production.
4. No identifying User-Agent — production logs see generic `node` UA.

Each of these is one flag. Adding a new script 06 would duplicate ~270
lines of fetch/hash/index plumbing. Extending 05 keeps the harness
single-purpose. The diff harness (07) consumes 05's output regardless.

## New flags (all additive, defaults preserve current behavior)

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--prod` | boolean | off | Flips `--base-url` default to `https://flexrz.com`, `--api-base-url` default to `https://booking-backend-6jbc.onrender.com`, and `--rate-limit-ms` default to `1000`. Each remains independently overridable. |
| `--custom-domains` | boolean | off | Adds `LEFT JOIN tenant_domains` to the tenant SELECT, and per-tenant URL becomes `https://<custom_domain>/` when the tenant has a primary custom domain. Schema-drift guard runs first; aborts if `tenant_domains.is_primary` is missing. |
| `--rate-limit-ms` | int | `0` (or `1000` if `--prod`) | Sleep duration between tenants. The sleep happens after each tenant's full block (both HTTP fetches + 4 file writes). |
| `--user-agent` | string | `Flexrz-Internal-Phase-5-3-Audit/1.0` | Sent on every fetch. Lets production observability identify internal-audit traffic vs real users. |

The `--prod` flag is a coherent bundle — it changes three defaults that
all serve "talk to production like a polite internal client." If you
need only some of those defaults, pass each flag explicitly.

## Default-preservation guarantee

Running the script with **no new flags** captures from localhost
(`http://localhost:3000` HTML, `http://localhost:3001` API), no rate
limiting, no custom domain lookup, and sends the new User-Agent header
(the only observable diff from pre-extension; non-breaking).

The User-Agent header is the single behavior change for existing
callers. If a localhost dev server logs UA somewhere visible, it'll
now show `Flexrz-Internal-Phase-5-3-Audit/1.0` instead of the Node
default. Acceptable trade.

## Schema-drift guard

`--custom-domains` requires `tenant_domains.is_primary` to exist. The
script probes `information_schema.columns` before the main loop. If
the column is missing, the script aborts with exit code 1 and a
message pointing at `audit/2026-05-14/schema_drift/REPORT.md`. This
prevents the bug-shaped failure mode of "captured 25 tenants but
silently missed the 8 on custom domains."

## Canonical prod-capture invocation

```bash
cd booking-backend
node scripts/themes_v2/05_capture_render_baseline.js \
  --prod \
  --custom-domains \
  --output-dir=snapshots/phase-5-3-baseline
```

Notes:
- `--output-dir=snapshots/phase-5-3-baseline` is **explicit on purpose**
  — the script's default stays `.audit/baseline` (gitignored). The
  Phase 5.3 baselines are meant to be shared with the diff harness
  (script 07) and possibly committed; routing them to `snapshots/` is
  the convention.
- Add `--slug-filter=birdie-golf` for the smoke test before running
  the full 25-tenant capture.
- Pass `--rate-limit-ms=2000` to slow it down if production logs show
  rate-limiter pushback at the default 1000ms.

## Smoke test (Birdie only)

Before the full prod capture, verify the resolver and schema guard
work end-to-end with one tenant. Use a SEPARATE output directory so
the smoke run never clobbers the eventual 25-tenant baseline that the
diff harness will read:

```bash
node scripts/themes_v2/05_capture_render_baseline.js \
  --prod \
  --custom-domains \
  --slug-filter=birdie-golf \
  --output-dir=snapshots/phase-5-3-baseline-smoke
```

Expected:
- One row in the output table for `birdie-golf`.
- `INDEX.json:captured[0].usedCustomDomain = true`, `customDomain`
  populated.
- HTML status 200, sane byte count (>50KB for a published premium
  tenant).
- API status 200, JSON body that parses.

If `usedCustomDomain` is `false` for Birdie, the custom-domain join
didn't return a primary row — investigate `tenant_domains` rows for
`tenant_id=3` before scaling to 25.

## INDEX.json additions

`INDEX.json` gains four top-level fields plus two per-tenant fields.
All optional / non-breaking; older readers (e.g. a stale diff tool)
keep working:

```jsonc
{
  "timestamp": "...",
  "prodMode": true,                 // NEW
  "htmlBase": "https://flexrz.com",
  "apiBase": "...",
  "timeoutMs": 5000,
  "customDomainsEnabled": true,     // NEW
  "rateLimitMs": 1000,              // NEW
  "userAgent": "...",               // NEW
  "slugFilter": null,
  "tenantCount": 25,
  "captured": [
    {
      "slug": "...",
      "tenantId": 3,
      "themeKey": "premium_v2",
      "usedCustomDomain": true,     // NEW
      "customDomain": "...",        // NEW (or null)
      "html": { ... },
      "api": { ... }
    }
  ],
  "findings": []
}
```

The diff harness (`07_diff_against_baseline.js`) reads `usedCustomDomain`
+ `customDomain` to re-fetch from the same URL during the post-refactor
capture, ensuring apples-to-apples comparison.

## Cross-references

- `phase-5-3-tenant-inventory.md` — input data for `--custom-domains`.
- `phase-5-3-section-inventory.md` — what the captured HTML must
  remain byte-identical for, post-refactor.
- `phase-5-3-patch-tracker.md` — patches whose preservation the diff
  harness verifies.
- `phase-5-3-rollback-plan.md` — fallback if diff > 0 for any tenant.
