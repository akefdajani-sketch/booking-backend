# Themes v2 — Backend Stable Key Order (Follow-up)

> **Status:** open. Discovered 2026-06-01 during Phase 5.3 equivalence-harness
> smoke run. Masked at harness level; backend fix pending.

## Problem

The `/api/public/tenant-theme/<slug>` response's `appearance` subtree
(`landing`, `assets`, `resolvedCssVars`, `resolvedContractCssVars`) is emitted
with non-deterministic JSON key order. Cold-compose path (cache miss,
`snapshotUsed:false, snapshotVersion:N`) and warm-snapshot path
(`snapshotUsed:true, snapshotVersion:N+1`) produce same keys + same values in
different order.

Confirmed on meesh (tenant 27) via two back-to-back captures from
`https://flexrz.com/book/meesh`: 9224-byte differing region in the SSR
HTML, zero Flight component-tree markers — pure data reorder. Standalone API
`<slug>.api.json` exhibits the same behavior but happened to hash-match because
both captures landed AFTER the cache had warmed.

## Affected surfaces

1. Standalone `/api/public/tenant-theme/<slug>` JSON.
2. Embedded duplicate of the same payload inside the React Flight stream at
   `/book/<slug>` (carried as escaped JSON in `__next_f.push([N,"…"])`).

## Harness mitigation (in `scripts/themes_v2/07_diff_against_baseline.js`)

- `canonicalizeJson` (recursive `sortDeep` + `JSON.parse/stringify`) on the
  standalone API artifact, wired into `compareTenant` as a canonical-form
  fallback when the raw SHA fast-path misses.
- `embedded_appearance_data_island` regex rule in `REGEX_RULES`, bounded by
  `"landing":{` left anchor and `"snapshotUsed":[CACHE]` right anchor.

Verified meesh A/B self-diff goes to zero after both mitigations. Birdie smoke
+ 7-tenant baseline run on top of these mitigations.

## Root-cause hypothesis (not investigated)

The non-determinism almost certainly originates in the tenant-theme snapshot
serializer. Two plausible mechanisms:

- Snapshot built via `Object.assign({}, source1, source2)` where `source*`
  iteration order varies between requests.
- JSONB column round-trip altering key order on warm-path read.

Backend triage owner unassigned. Investigate `routes/publicTenantTheme.js` +
the snapshot composer + any JSONB columns in the request path.

## Fix proposal (when scoped)

Either:

- A. Sort object keys at snapshot-write time so cold and warm paths produce
  identical JSON byte-for-byte.
- B. Refactor the cold-compose path to use the same serializer the warm-snapshot
  path reads (so both paths share one deterministic emission step).

Option A is smaller. Option B is structurally cleaner.

## Removing the harness mitigation

After the backend fix lands and is verified stable across N captures, the
`canonicalizeJson` fallback and `embedded_appearance_data_island` rule can be
removed from `07.js` — but they're harmless if left in (belt-and-suspenders).
