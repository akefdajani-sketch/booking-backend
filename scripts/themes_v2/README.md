# scripts/themes_v2

Tooling for THEMES-V2 Phase 5.1 — sync `theme/contractThemeRegistry.js` (the
backend code registry) into `platform_themes` (the DB source of truth) for
themes that are currently missing or empty there.

Architectural premise (decided in the parent session): the DB row is the
source of truth. The `LEFT JOIN platform_themes` in
`theme/resolveTenantAppearanceSnapshot.js:528-529` returns NULL for missing
keys today; the 3.2-RETRY-2 patch falls back to code defaults. That fallback
works, but DB rows make the contract explicit and let the platform admin UI
manage themes without code changes.

## Phase 5.1 hard constraints

- **Protected tenants** — Birdie Golf (id=3, slug=`birdie-golf`), Al-Razi
  (id=21), aqababooking (id=33). Any candidate row that produces a non-zero
  `resolvedCssVars` diff for ANY of these is hard-skipped.
- **`premium-hospitality` is excluded entirely** in this phase. Birdie stays
  on the code-only fallback until ak greenlights. Even passing
  `--rows=premium-hospitality` to the audit will reject it.
- **Existing rows are never overwritten.** A row in `platform_themes` with a
  non-empty `tokens_json` triggers `SKIP_ROW_HAS_EXISTING_TOKENS`.
  Re-baselining is a separate phase.
- **Idempotent.** Re-running Scripts 1 and 2 must be safe.

## Scripts

| # | Script | Status | Purpose |
|---|--------|--------|---------|
| 1 | `01_audit_theme_sync.js` | implemented | Read-only audit. Writes `.audit/01_audit_<ISO>.json` and `.audit/latest.json`. |
| 2 | `02_apply_theme_sync.js` | implemented | Idempotent UPSERT of audit-cleared rows. Reads `--from-audit=latest.json`. Refreshes affected tenants' snapshots. Defaults to dry-run; `--apply` writes. |
| 2b | `02b_publish_theme_sync.js` | implemented | Flips `is_published` `FALSE → TRUE` for previously-inserted unpublished rows after a fresh diff re-run against current DB state. Independent of Script 2. Defaults to dry-run; `--apply` writes. |
| 3 | `03_verify_post_sync.js` | implemented | Re-snapshots all tenants, compares to live stored snapshots (or to a baseline file), asserts zero diff for protected tenants. Optional `--write-baseline=<file>` mode for capturing pre-apply state. |
| 4 | `04_rollback.sql` | implemented | `DELETE FROM platform_themes WHERE key IN ('minimal', 'boutique-beauty') AND version = 1`, wrapped in a transaction with pre/post inspection queries. |

## Workflow

```bash
# 1. Audit (always start here)
node scripts/themes_v2/01_audit_theme_sync.js

# 2. Review .audit/latest.json or stdout. If happy:
node scripts/themes_v2/02_apply_theme_sync.js --from-audit=latest.json

# 3. Verify
node scripts/themes_v2/03_verify_post_sync.js

# 4. (Optional, gated) publish classic/premium/minimal once eyeballed
node scripts/themes_v2/02b_publish_theme_sync.js --keys=classic,premium,minimal
```

## Recommendation taxonomy (Script 1)

| Recommendation | Meaning | What Script 2 does |
|----------------|---------|--------------------|
| `SAFE_INSERT` | Zero `resolvedCssVars` diff for every affected tenant assuming `is_published=TRUE`. | Insert. `is_published=TRUE` for `boutique-beauty`, `FALSE` for the rest (per ak's split rule). |
| `NO_TENANTS_AFFECTED` | No tenants on this `theme_key` (typically `boutique-beauty` until Studio Nur ships). | Insert at `is_published=TRUE` (cannot break anyone). |
| `SKIP_DUE_TO_DIFF` | At least one non-protected tenant's resolved vars would change. | Skip. Inserting at `is_published=FALSE` is technically safe (resolver ignores unpublished rows) but Phase 5.1 won't insert without audit clearance. |
| `SKIP_DUE_TO_PROTECTED_DIFF` | Protected tenant (3 / 21 / 33) would diff. | Skip. Hard stop. |
| `SKIP_ROW_HAS_EXISTING_TOKENS` | Row already has non-empty `tokens_json`. | Skip. Out of scope for Phase 5.1. |
| `ERROR_NOT_IN_REGISTRY` | Theme key not present in `theme/contractThemeRegistry.js`. | Skip. |

## Diff math note

The audit assumes `is_published=TRUE` for the simulated row. The resolver's
LEFT JOIN at `theme/resolveTenantAppearanceSnapshot.js:528-529` filters by
`pt.is_published = TRUE`, so an unpublished row is invisible to it. That
means `SKIP_DUE_TO_DIFF` rows could in principle be inserted at
`is_published=FALSE` with zero runtime impact — but Phase 5.1 doesn't take
that shortcut. We only insert what the audit clears.

## Why these specific keys, in this order

| Key | Phase 5.1 outcome (expected) | Rationale |
|-----|------------------------------|-----------|
| `boutique-beauty` | `NO_TENANTS_AFFECTED` → insert published | Mandatory for Phase 3.4 (Studio Nur). Zero production tenants. |
| `classic` | likely `SKIP_DUE_TO_DIFF` | Largest tenant cohort. Brand-overrides on `--bf-page-bg` etc. across many tenants make exact zero-diff unlikely. |
| `premium` | likely `SKIP_DUE_TO_DIFF` | Same reason as classic; many tenants. |
| `minimal` | likely `SAFE_INSERT` if 0 tenants on this key, else `SKIP_DUE_TO_DIFF` | Migration 067's audit (now stale) showed 0 tenants on `minimal`. Confirm from live DB. |
| `premium-hospitality` | EXCLUDED | Birdie hold; ak greenlight required. |

## Diff comparator semantics

`diffMaps()` in Script 1 normalizes CSS values before comparing:
- `rgb()`/`rgba()` → canonical `rgb(r, g, b)` / `rgba(r, g, b, a)` with
  single-space separators. `rgba(...,1)` collapses to `rgb(...)`.
- Hex → lowercase, 3-char expanded to 6-char.
- Anything else → trim + collapse whitespace runs.

The diff output always reports the **original** values, not normalized
forms, so reviewers see what's actually stored.

Diffs are tagged:
- `[+ADDITION]` — `current` was undefined/null and `simulated` adds a value.
  Counts as a diff under Phase 5.1's conservative semantic. A future
  re-baseline pass could elect to treat additions as "no conflict" since
  they don't clobber anything; **not** changing that today. Notably,
  `--bf-modal-backdrop` is a pure addition for every contract-registry
  candidate (the resolver's `buildResolvedCssVars` doesn't emit it),
  so even a perfect classic re-baseline would register one ADDITION
  per tenant from this alone.
- `[BLOCKED — should not appear]` — key is in the resolver's `BLOCKED`
  set; tokens_json values for these keys are no-ops. If this tag fires,
  the candidate generator is doing something wrong.

## Phase 5.1.5 follow-up (non-blocking)

Backlog items captured during Phase 5.1:

1. **No migration creates `platform_themes`.** Table was provisioned
   out-of-band on production and seeded by `migrations/013_seed_premium_v2.sql`
   (which assumes it exists). Live column shape (per `routes/adminThemes.js`
   and the audit query): `key, name, version, is_published, layout_key,
   tokens_json, created_at, updated_at`. Note: `is_active` is referenced in
   `migrations/013` but does **not** exist on the live table — that
   migration appears to have been written against a draft schema that
   diverged. Capture the live schema in a `CREATE TABLE` migration (next
   free number after `068`) so fresh environments can be reconstructed.

2. **Typo'd row `premuim_light_v2`** (sic — "premuim" not "premium") exists
   in `platform_themes` with 6 tokens and `is_published=TRUE`. No tenant
   uses this key today (it would fail the migration 067 CHECK constraint
   since it's not in the allow-list — meaning the row predates 067 and
   has been orphaned). **DELETE the orphaned row as part of 5.1.5** —
   single migration captures schema AND removes orphan.
